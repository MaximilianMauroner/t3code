import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { providerUsageEnvironment } from "../../state/providerUsage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { codexUsagePresentation } from "./codexUsagePresentation";

export const CodexUsageIndicator = memo(function CodexUsageIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
}) {
  const atom = useMemo(
    () =>
      providerUsageEnvironment.codex({
        environmentId: props.environmentId,
        input: {
          providerInstanceId: props.providerInstanceId,
          model: props.model,
        },
      }),
    [props.environmentId, props.model, props.providerInstanceId],
  );
  const usage = useEnvironmentQuery(atom).data;
  if (
    !usage ||
    usage.model !== props.model ||
    usage.providerInstanceId !== props.providerInstanceId
  ) {
    return null;
  }
  const presentation = codexUsagePresentation(usage);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "text-muted-foreground/70 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums",
              usage.rateLimitReachedType && "text-amber-600",
            )}
            aria-label={`Codex usage: ${presentation.summary}`}
            data-codex-usage-model={usage.model}
          >
            <GaugeIcon className="size-3.5" />
            <span className="whitespace-nowrap">{presentation.summary}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-line">
        {presentation.details}
      </TooltipPopup>
    </Tooltip>
  );
});
