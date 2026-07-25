export interface ThreadLifecycleSnackbarState {
  readonly id: number;
  readonly snoozedUntil: string;
  readonly onUndo: () => Promise<boolean>;
}

export type ThreadLifecycleSnackbarEvent =
  | { readonly type: "show"; readonly state: ThreadLifecycleSnackbarState }
  | { readonly type: "dismiss" }
  | { readonly type: "expire" };

export function reduceThreadLifecycleSnackbar(
  current: ThreadLifecycleSnackbarState | null,
  event: ThreadLifecycleSnackbarEvent,
): ThreadLifecycleSnackbarState | null {
  if (event.type === "show") return event.state;
  return current === null ? current : null;
}

export function createThreadLifecycleUndoCoordinator() {
  let inFlightId: number | null = null;
  return {
    async execute(
      state: ThreadLifecycleSnackbarState,
      currentId: () => number | null,
      onSucceeded: () => void,
    ): Promise<boolean> {
      if (inFlightId === state.id) return false;
      inFlightId = state.id;
      try {
        const succeeded = await state.onUndo().catch(() => false);
        if (succeeded && currentId() === state.id) onSucceeded();
        return succeeded;
      } finally {
        if (inFlightId === state.id) inFlightId = null;
      }
    },
  };
}
