import type { TimestampFormat } from "@t3tools/contracts/settings";
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { memo } from "react";
import type {
  ThreadRecoveryPresentation,
  ThreadRecoveryRetry,
} from "../../threadRecoveryPresentation";
import { recoveryRetryUnavailableMessage } from "../../threadRecoveryPresentation";
import { formatTimestamp } from "../../timestampFormat";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export const ThreadRecoveryBanner = memo(function ThreadRecoveryBanner({
  presentation,
  retry,
  retrying,
  timestampFormat,
  onRetry,
}: {
  presentation: ThreadRecoveryPresentation | null;
  retry: ThreadRecoveryRetry;
  retrying: boolean;
  timestampFormat: TimestampFormat;
  onRetry: () => void;
}) {
  if (presentation === null) return null;

  const detectedLabel = presentation.detectedAt
    ? formatTimestamp(presentation.detectedAt, timestampFormat)
    : null;
  const lastObservedLabel = presentation.executionLastObservedAt
    ? formatTimestamp(presentation.executionLastObservedAt, timestampFormat)
    : null;
  const retryUnavailable =
    retry.kind === "unavailable" ? recoveryRetryUnavailableMessage(retry.reason) : null;

  return (
    <div className="mx-auto w-fit max-w-[min(52rem,calc(100%-2rem))] pt-3">
      <Alert variant="warning" aria-label="Interrupted turn status">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>{presentation.title}</AlertTitle>
        <AlertDescription>
          <p>{presentation.message} Partial output is preserved below.</p>
          {detectedLabel ? (
            <dl className="grid grid-cols-1 gap-x-2 text-xs sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium text-foreground/80">Last execution observed</dt>
              <dd>
                {presentation.timestampFallback
                  ? "Unavailable — using interruption detection time"
                  : (lastObservedLabel ?? "Unavailable")}
              </dd>
              <dt className="font-medium text-foreground/80">Interruption detected</dt>
              <dd>{detectedLabel}</dd>
            </dl>
          ) : null}
          {retryUnavailable ? <p className="text-xs">{retryUnavailable}</p> : null}
          {retrying ? (
            <p className="text-xs" role="status" aria-live="polite">
              Retrying the original prompt and attachments…
            </p>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retry.kind === "unavailable" || retrying}
            aria-label="Retry interrupted turn with original prompt and attachments"
            onClick={onRetry}
          >
            <RotateCcwIcon aria-hidden />
            {retrying ? "Retrying" : "Retry original"}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
