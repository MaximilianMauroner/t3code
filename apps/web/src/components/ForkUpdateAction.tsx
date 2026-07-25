import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ForkUpdateDescriptor,
  ServerForkUpdateStage,
  ServerForkUpdateStatus,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

const RECONNECT_PENDING_EXPIRY_MS = 12 * 60_000;

const ACTIVE_STAGES = new Set<ServerForkUpdateStage>([
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
]);

export function isForkUpdateActive(stage: ServerForkUpdateStage): boolean {
  return ACTIVE_STAGES.has(stage);
}

function shortCommit(commit: string | null | undefined): string {
  return commit?.slice(0, 8) ?? "unknown";
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The fork update request failed.";
}

function stageLabel(stage: ServerForkUpdateStage): string {
  return stage.replace("-", " ");
}

export function forkUpdateCompareUrl(descriptor: ForkUpdateDescriptor): string | null {
  if (descriptor.currentCommit === undefined) return null;
  const [upstreamOwner] = descriptor.upstreamRepository.split("/");
  if (!upstreamOwner) return null;

  const repository = descriptor.repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const base = encodeURIComponent(descriptor.currentCommit);
  const head = `${encodeURIComponent(upstreamOwner)}:${encodeURIComponent(descriptor.upstreamBranch)}`;
  return `https://github.com/${repository}/compare/${base}...${head}`;
}

export interface ForkUpdateStatusPresentation {
  readonly installedNightly: string;
  readonly latestReleasedNightly: string | null;
  readonly stage: string | null;
  readonly message: string | null;
  readonly detail: string | null;
  readonly showsRollbackWatch: boolean;
  readonly failed: boolean;
}

export function presentForkUpdateStatus(
  descriptor: ForkUpdateDescriptor,
  status: ServerForkUpdateStatus | null,
  queryError: string | null,
  installedNightlyVersion?: string,
  latestNightlyVersion?: string,
): ForkUpdateStatusPresentation {
  return {
    installedNightly: installedNightlyVersion ?? shortCommit(descriptor.currentCommit),
    latestReleasedNightly: latestNightlyVersion ?? null,
    stage: status === null ? null : stageLabel(status.stage),
    message: status?.message ?? null,
    detail: status?.error ?? queryError,
    showsRollbackWatch: status?.stage === "restarting" || status?.stage === "verifying",
    failed: status?.stage === "failed",
  };
}

function ForkUpdateStatusView({
  descriptor,
  status,
  queryError,
  installedNightlyVersion,
  latestNightlyVersion,
}: {
  readonly descriptor: ForkUpdateDescriptor;
  readonly status: ServerForkUpdateStatus | null;
  readonly queryError: string | null;
  readonly installedNightlyVersion: string | undefined;
  readonly latestNightlyVersion: string | undefined;
}) {
  const presentation = presentForkUpdateStatus(
    descriptor,
    status,
    queryError,
    installedNightlyVersion,
    latestNightlyVersion,
  );
  const compareUrl = forkUpdateCompareUrl(descriptor);
  return (
    <div className="space-y-1">
      <p>Installed nightly · {presentation.installedNightly}</p>
      <p>Latest released nightly · {presentation.latestReleasedNightly ?? "unavailable"}</p>
      {compareUrl !== null ? (
        <p>
          <a
            className="text-primary underline underline-offset-2 hover:no-underline"
            href={compareUrl}
            target="_blank"
            rel="noreferrer"
          >
            Review incoming commits
          </a>{" "}
          from {descriptor.upstreamRepository}:{descriptor.upstreamBranch}
        </p>
      ) : null}
      {presentation.stage !== null && presentation.message !== null ? (
        <p className={presentation.failed ? "text-destructive" : undefined}>
          <span className="capitalize">{presentation.stage}</span>: {presentation.message}
        </p>
      ) : null}
      {presentation.detail ? (
        <p className="max-w-xl whitespace-pre-wrap text-destructive">{presentation.detail}</p>
      ) : null}
      {presentation.showsRollbackWatch ? (
        <p>The new release is under a two-minute health watch and rolls back automatically.</p>
      ) : null}
    </div>
  );
}

export function ForkUpdateAction({
  environmentId,
  descriptor,
}: {
  readonly environmentId: EnvironmentId;
  readonly descriptor: ForkUpdateDescriptor;
}) {
  const statusQuery = useEnvironmentQuery(
    serverEnvironment.forkUpdateStatus({
      environmentId,
      input: {},
    }),
  );
  const startForkUpdate = useAtomCommand(serverEnvironment.startForkUpdate, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const observedActiveRef = useRef(false);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = statusQuery.data?.status ?? null;
  const active = status !== null && isForkUpdateActive(status.stage);

  useEffect(() => {
    if (active) {
      observedActiveRef.current = true;
      return;
    }
    if (!pending || !observedActiveRef.current) return;
    inFlightRef.current = false;
    observedActiveRef.current = false;
    setPending(false);
    if (expiryRef.current !== null) {
      clearTimeout(expiryRef.current);
      expiryRef.current = null;
    }
  }, [active, pending, status]);

  useEffect(
    () => () => {
      if (expiryRef.current !== null) {
        clearTimeout(expiryRef.current);
      }
      inFlightRef.current = false;
      observedActiveRef.current = false;
    },
    [],
  );

  const handleStart = () => {
    if (inFlightRef.current || active) return;
    inFlightRef.current = true;
    observedActiveRef.current = false;
    setPending(true);
    setRequestError(null);
    expiryRef.current = setTimeout(() => {
      expiryRef.current = null;
      inFlightRef.current = false;
      observedActiveRef.current = false;
      setPending(false);
      setRequestError(
        "The update request timed out. The server may still be working; its persisted status will appear after reconnection.",
      );
    }, RECONNECT_PENDING_EXPIRY_MS);

    void Promise.resolve()
      .then(() => startForkUpdate({ environmentId, input: {} }))
      .then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setRequestError(failureMessage(squashAtomCommandFailure(result)));
            inFlightRef.current = false;
            observedActiveRef.current = false;
            setPending(false);
            if (expiryRef.current !== null) {
              clearTimeout(expiryRef.current);
              expiryRef.current = null;
            }
          }
          return;
        }
        if (isForkUpdateActive(result.value.status.stage)) {
          observedActiveRef.current = true;
        } else {
          inFlightRef.current = false;
          observedActiveRef.current = false;
          setPending(false);
          if (expiryRef.current !== null) {
            clearTimeout(expiryRef.current);
            expiryRef.current = null;
          }
        }
        statusQuery.refresh();
      })
      .catch((error: unknown) => {
        setRequestError(failureMessage(error));
        inFlightRef.current = false;
        observedActiveRef.current = false;
        setPending(false);
        if (expiryRef.current !== null) {
          clearTimeout(expiryRef.current);
          expiryRef.current = null;
        }
      });
  };

  const disabled = pending || active;
  return (
    <SettingsRow
      title="Nightly updates"
      description={`Pull from ${descriptor.upstreamRepository}:${descriptor.upstreamBranch}, merge into ${descriptor.repository}:${descriptor.branch}, validate, and deploy the exact commit. Active turns block updates.`}
      status={
        <ForkUpdateStatusView
          descriptor={descriptor}
          status={status}
          queryError={requestError ?? statusQuery.error}
          installedNightlyVersion={statusQuery.data?.installedNightlyVersion}
          latestNightlyVersion={statusQuery.data?.latestNightlyVersion}
        />
      }
      control={
        <Button size="xs" disabled={disabled} onClick={handleStart}>
          {disabled ? <Spinner className="size-3.5" /> : null}
          Pull from nightly
        </Button>
      }
    />
  );
}
