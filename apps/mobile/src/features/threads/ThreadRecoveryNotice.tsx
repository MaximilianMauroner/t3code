import type { EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { useAssetUrl } from "../../state/assets";
import {
  hydrateRecoveryAttachments,
  recoveryAttachmentUnavailableDetail,
} from "./threadRecoveryAttachments";
import {
  RECOVERY_PARTIAL_OUTPUT_NOTICE,
  recoveryRetryUnavailableDetail,
  type ThreadRecoveryPresentation,
} from "./threadRecoveryPresentation";

const RECOVERY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function recoveryTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Unknown" : RECOVERY_TIME_FORMATTER.format(timestamp);
}

function RecoveryAttachmentUrl(props: {
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId;
  readonly onChange: (attachmentId: string, url: string | null) => void;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
  });
  useEffect(() => {
    props.onChange(props.attachmentId, url);
  }, [props.attachmentId, props.onChange, url]);
  return null;
}

export interface ThreadRecoveryRetryInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly sourceProposedPlan: Extract<
    ThreadRecoveryPresentation["retry"],
    { readonly kind: "available" }
  >["sourceProposedPlan"];
}

export function ThreadRecoveryNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly presentation: ThreadRecoveryPresentation;
  readonly onRetry: (input: ThreadRecoveryRetryInput) => Promise<boolean>;
}) {
  const retryInFlightRef = useRef(false);
  const [urlsByAttachmentId, setUrlsByAttachmentId] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [retryState, setRetryState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "queued" }
    | { readonly kind: "error"; readonly detail: string }
  >({ kind: "idle" });

  const retry = props.presentation.retry;
  const attachmentKey = `${props.presentation.kind}:${props.presentation.detectedAt}:${
    retry.kind === "available"
      ? retry.attachments.map((attachment) => attachment.id).join(":")
      : "unavailable"
  }`;
  useEffect(() => {
    setUrlsByAttachmentId({});
    setRetryState({ kind: "idle" });
    retryInFlightRef.current = false;
  }, [attachmentKey]);

  const handleAttachmentUrlChange = useCallback((attachmentId: string, url: string | null) => {
    setUrlsByAttachmentId((current) =>
      current[attachmentId] === url ? current : { ...current, [attachmentId]: url },
    );
  }, []);

  const attachmentsReady =
    retry.kind === "available" &&
    retry.attachments.every((attachment) => Boolean(urlsByAttachmentId[attachment.id]));
  const unavailableDetail = useMemo(() => {
    if (retry.kind === "unavailable") {
      if (props.presentation.kind === "stale-runtime") {
        return "Retry becomes available after recovery settles the turn.";
      }
      if (props.presentation.kind === "start-interrupted") {
        return "The original message remains above so you can edit or send it again.";
      }
      return recoveryRetryUnavailableDetail(retry.reason);
    }
    if (!attachmentsReady && retry.attachments.length > 0) {
      return "Retry is unavailable until every original attachment can be loaded.";
    }
    return null;
  }, [attachmentsReady, props.presentation.kind, retry]);

  const handleRetry = useCallback(async () => {
    if (retry.kind !== "available" || !attachmentsReady || retryInFlightRef.current) {
      return;
    }
    retryInFlightRef.current = true;
    setRetryState({ kind: "loading" });
    const hydration = await hydrateRecoveryAttachments({
      attachments: retry.attachments,
      urlsByAttachmentId,
    });
    if (hydration.kind === "unavailable") {
      retryInFlightRef.current = false;
      setRetryState({ kind: "error", detail: recoveryAttachmentUnavailableDetail(hydration) });
      return;
    }

    const queued = await props.onRetry({
      text: retry.text,
      attachments: hydration.attachments,
      sourceProposedPlan: retry.sourceProposedPlan,
    });
    if (!queued) {
      retryInFlightRef.current = false;
      setRetryState({
        kind: "error",
        detail: "The retry could not be queued. Your original message was not changed.",
      });
      return;
    }
    setRetryState({ kind: "queued" });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [attachmentsReady, props, retry, urlsByAttachmentId]);

  const actionDisabled =
    retry.kind !== "available" ||
    !attachmentsReady ||
    retryState.kind === "loading" ||
    retryState.kind === "queued";
  const actionLabel =
    retryState.kind === "loading"
      ? "Preparing retry…"
      : retryState.kind === "queued"
        ? "Retry queued"
        : "Retry original message";

  return (
    <View
      accessibilityLiveRegion="polite"
      className="my-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      {retry.kind === "available"
        ? retry.attachments.map((attachment) => (
            <RecoveryAttachmentUrl
              key={attachment.id}
              attachmentId={attachment.id}
              environmentId={props.environmentId}
              onChange={handleAttachmentUrlChange}
            />
          ))
        : null}
      <View className="flex-row items-start gap-3">
        <SymbolView name="exclamationmark.triangle.fill" size={18} tintColor="#d97706" />
        <View className="min-w-0 flex-1 gap-1">
          <Text accessibilityRole="header" className="font-t3-semibold text-base text-foreground">
            {props.presentation.title}
          </Text>
          <Text className="text-sm leading-normal text-foreground-secondary">
            {props.presentation.detail}
          </Text>
          <Text className="text-sm leading-normal text-foreground-secondary">
            {RECOVERY_PARTIAL_OUTPUT_NOTICE}
          </Text>
          <View className="mt-1 gap-0.5">
            <Text className="text-xs text-foreground-muted">
              Last execution observed:{" "}
              {props.presentation.executionLastObservedAt === null
                ? "Unavailable"
                : recoveryTime(props.presentation.executionLastObservedAt)}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {props.presentation.kind === "stale-runtime"
                ? "Status mismatch observed"
                : "Interruption detected"}
              : {recoveryTime(props.presentation.detectedAt)}
            </Text>
          </View>
          {unavailableDetail ? (
            <Text className="mt-1 text-xs leading-normal text-foreground-muted">
              {unavailableDetail}
            </Text>
          ) : null}
          {retryState.kind === "error" ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-1 text-xs leading-normal text-red-600 dark:text-red-400"
            >
              {retryState.detail}
            </Text>
          ) : null}
          {retryState.kind === "queued" ? (
            <Text accessibilityLiveRegion="polite" className="mt-1 text-xs text-foreground-muted">
              The exact original message was added to the send queue.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            accessibilityHint={
              unavailableDetail ?? "Queues the exact original message and attachments."
            }
            accessibilityState={{ disabled: actionDisabled, busy: retryState.kind === "loading" }}
            disabled={actionDisabled}
            className={`mt-2 min-h-11 self-start justify-center rounded-lg px-3 ${
              actionDisabled ? "bg-foreground/10" : "bg-foreground"
            }`}
            onPress={() => void handleRetry()}
          >
            <Text
              className={`font-t3-semibold text-sm ${
                actionDisabled ? "text-foreground-muted" : "text-background"
              }`}
            >
              {actionLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
