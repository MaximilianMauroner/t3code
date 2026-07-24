import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function ThreadLifecycleNotice(props: {
  readonly state: "snoozed" | "settled";
  readonly onRestore: () => void;
}) {
  const action = props.state === "snoozed" ? "Wake" : "Un-settle";
  return (
    <View className="mx-4 mt-2 flex-row items-center rounded-xl bg-subtle px-3 py-2">
      <Text className="flex-1 text-sm text-foreground-muted">This thread is {props.state}.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={action} onPress={props.onRestore}>
        <Text className="text-sm font-t3-medium text-sky-600 dark:text-sky-400">{action}</Text>
      </Pressable>
    </View>
  );
}
