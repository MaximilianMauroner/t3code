import { snoozeWakeDescription } from "@t3tools/client-runtime/thread-snooze";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { OverlayPortal } from "../../components/OverlayPortal";
import {
  createThreadLifecycleUndoCoordinator,
  type ThreadLifecycleSnackbarState,
} from "./threadLifecycleSnackbarState";

export type { ThreadLifecycleSnackbarState } from "./threadLifecycleSnackbarState";

export function ThreadLifecycleSnackbar(props: {
  readonly state: ThreadLifecycleSnackbarState | null;
  readonly onDismiss: () => void;
}) {
  const onDismissRef = useRef(props.onDismiss);
  onDismissRef.current = props.onDismiss;
  const stateRef = useRef(props.state);
  stateRef.current = props.state;
  const undoCoordinatorRef = useRef(createThreadLifecycleUndoCoordinator());
  useEffect(() => {
    if (props.state === null) return;
    const id = setTimeout(() => onDismissRef.current(), 5_000);
    return () => clearTimeout(id);
  }, [props.state]);
  if (props.state === null) return null;
  const description = snoozeWakeDescription(props.state.snoozedUntil, new Date());
  return (
    <OverlayPortal>
      <View pointerEvents="box-none" className="flex-1 justify-end px-4 pb-8">
        <View className="flex-row items-center rounded-xl bg-foreground px-4 py-3 shadow-lg">
          <Text className="flex-1 text-sm text-screen">
            Snoozed{description ? ` until ${description}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo snooze"
            onPress={() => {
              const state = stateRef.current;
              if (state === null) return;
              void undoCoordinatorRef.current.execute(
                state,
                () => stateRef.current?.id ?? null,
                () => onDismissRef.current(),
              );
            }}
          >
            <Text className="font-t3-medium text-sm text-sky-600 dark:text-sky-400">Undo</Text>
          </Pressable>
        </View>
      </View>
    </OverlayPortal>
  );
}
