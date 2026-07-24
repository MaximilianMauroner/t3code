import { describe, expect, it, vi } from "vite-plus/test";
import {
  createThreadLifecycleUndoCoordinator,
  reduceThreadLifecycleSnackbar,
  type ThreadLifecycleSnackbarState,
} from "./threadLifecycleSnackbarState";

function state(id: number, onUndo = vi.fn(async () => true)): ThreadLifecycleSnackbarState {
  return { id, snoozedUntil: `2026-06-0${id}T00:00:00.000Z`, onUndo };
}

describe("thread lifecycle snackbar state", () => {
  it("replaces an older snooze and clears on expiry or dismissal", () => {
    const first = state(1);
    const second = state(2);
    expect(reduceThreadLifecycleSnackbar(first, { type: "show", state: second })).toBe(second);
    expect(reduceThreadLifecycleSnackbar(second, { type: "expire" })).toBeNull();
    expect(reduceThreadLifecycleSnackbar(second, { type: "dismiss" })).toBeNull();
  });

  it("invokes Wake once and dismisses only after a successful current Undo", async () => {
    let resolveUndo!: (succeeded: boolean) => void;
    const onUndo = vi.fn(() => new Promise<boolean>((resolve) => (resolveUndo = resolve)));
    const entry = state(1, onUndo);
    const dismiss = vi.fn();
    const coordinator = createThreadLifecycleUndoCoordinator();
    const first = coordinator.execute(entry, () => 1, dismiss);
    const duplicate = await coordinator.execute(entry, () => 1, dismiss);
    resolveUndo(true);
    expect(await first).toBe(true);
    expect(duplicate).toBe(false);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss for failed Undo or when a newer snooze replaced it", async () => {
    const dismiss = vi.fn();
    const failed = state(
      1,
      vi.fn(async () => false),
    );
    expect(await createThreadLifecycleUndoCoordinator().execute(failed, () => 1, dismiss)).toBe(
      false,
    );
    const replaced = state(
      1,
      vi.fn(async () => true),
    );
    expect(await createThreadLifecycleUndoCoordinator().execute(replaced, () => 2, dismiss)).toBe(
      true,
    );
    expect(dismiss).not.toHaveBeenCalled();
  });
});
