import type { Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentId,
  ForkUpdateDescriptor,
  ServerForkUpdateStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

const testState = vi.hoisted(() => ({
  startForkUpdate: vi.fn(),
  refresh: vi.fn(),
  query: {
    data: null as { readonly status: ServerForkUpdateStatus } | null,
    error: null as string | null,
    isPending: false,
  },
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useEffect() {
      nextIndex();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ ...testState.query, refresh: testState.refresh }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    forkUpdateStatus: vi.fn(() => Symbol("forkUpdateStatus")),
    startForkUpdate: Symbol("startForkUpdate"),
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.startForkUpdate,
}));

import {
  ForkUpdateAction,
  forkUpdateCompareUrl,
  isForkUpdateActive,
  presentForkUpdateStatus,
} from "./ForkUpdateAction";

const DESCRIPTOR: ForkUpdateDescriptor = {
  repository: "owner/fork",
  upstreamRepository: "upstream/project",
  branch: "main",
  upstreamBranch: "nightly",
  currentCommit: "0123456789abcdef",
};

type RowElement = ReactElement<{
  readonly status?: ReactNode;
  readonly control?: ReactElement<{
    readonly disabled?: boolean;
    readonly onClick?: () => void;
  }>;
}>;

function renderAction(): RowElement {
  hooks.beginRender();
  return ForkUpdateAction({
    environmentId: "environment-1" as EnvironmentId,
    descriptor: DESCRIPTOR,
  }) as RowElement;
}

function status(stage: ServerForkUpdateStatus["stage"]): ServerForkUpdateStatus {
  return {
    stage,
    message: `${stage} message`,
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: null,
    currentCommit: "0123456789abcdef",
    targetCommit: "fedcba9876543210",
    error: null,
  };
}

describe("ForkUpdateAction", () => {
  beforeEach(() => {
    hooks.reset();
    testState.startForkUpdate.mockReset();
    testState.refresh.mockReset();
    testState.query.data = null;
    testState.query.error = null;
    testState.query.isPending = false;
  });

  it("dispatches once for rapid repeated clicks and disables immediately", () => {
    testState.startForkUpdate.mockReturnValue(new Promise(() => undefined));

    const first = renderAction();
    first.props.control?.props.onClick?.();
    first.props.control?.props.onClick?.();

    expect(testState.startForkUpdate).not.toHaveBeenCalled();
    return Promise.resolve().then(() => {
      expect(testState.startForkUpdate).toHaveBeenCalledTimes(1);
      expect(testState.startForkUpdate).toHaveBeenCalledWith({
        environmentId: "environment-1",
        input: {},
      });
      expect(renderAction().props.control?.props.disabled).toBe(true);
    });
  });

  it("links to the commits between the deployed release and upstream branch", () => {
    expect(forkUpdateCompareUrl(DESCRIPTOR)).toBe(
      "https://github.com/owner/fork/compare/0123456789abcdef...upstream:nightly",
    );
    expect(
      forkUpdateCompareUrl({
        repository: DESCRIPTOR.repository,
        upstreamRepository: DESCRIPTOR.upstreamRepository,
        branch: DESCRIPTOR.branch,
        upstreamBranch: DESCRIPTOR.upstreamBranch,
      }),
    ).toBeNull();
  });

  it("keeps the action disabled throughout every active persisted stage", () => {
    for (const stage of [
      "checking",
      "fetching",
      "merging",
      "validating",
      "building",
      "packaging",
      "pushing",
      "deploying",
      "restarting",
      "verifying",
    ] as const) {
      expect(isForkUpdateActive(stage)).toBe(true);
      testState.query.data = { status: status(stage) };
      expect(renderAction().props.control?.props.disabled).toBe(true);
    }
  });

  it("keeps waiting when restart interrupts the RPC transport", async () => {
    testState.startForkUpdate.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.control?.props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(renderAction().props.control?.props.disabled).toBe(true);
  });

  it("preserves failure and rollback details and explains the health watch", () => {
    const failed = {
      ...status("failed"),
      message: "The updated server stayed unhealthy for two minutes and was rolled back.",
      error: "Automatic health verification failed; the previous release was restored.",
    };
    const failurePresentation = presentForkUpdateStatus(DESCRIPTOR, failed, null);
    expect(failurePresentation).toMatchObject({
      failed: true,
      detail: "Automatic health verification failed; the previous release was restored.",
      message: "The updated server stayed unhealthy for two minutes and was rolled back.",
    });
    expect(presentForkUpdateStatus(DESCRIPTOR, failed, "transport failed")).toEqual(
      failurePresentation,
    );
    expect(presentForkUpdateStatus(DESCRIPTOR, status("verifying"), null)).toMatchObject({
      showsRollbackWatch: true,
    });
  });
});
