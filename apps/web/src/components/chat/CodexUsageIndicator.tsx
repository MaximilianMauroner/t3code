import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { Fragment, memo, type ReactNode, useMemo, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { providerUsageEnvironment } from "../../state/providerUsage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { codexUsagePresentation } from "./codexUsagePresentation";

export const CodexUsageIndicator = memo(function CodexUsageIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly modelPickerOpen: boolean;
  readonly children: ReactNode;
}) {
  const [isHoveredOrFocused, setIsHoveredOrFocused] = useState(false);
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
    return <Fragment>{props.children}</Fragment>;
  }
  const presentation = codexUsagePresentation(usage);

  return (
    <Tooltip
      open={props.modelPickerOpen || isHoveredOrFocused}
      onOpenChange={setIsHoveredOrFocused}
    >
      <TooltipTrigger
        render={
          <span
            className="inline-flex min-w-0 shrink"
            data-codex-usage-trigger-model={usage.model}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup
        side="bottom"
        align="start"
        sideOffset={8}
        className="max-w-72 whitespace-normal"
      >
        <span
          className={cn(
            "inline-flex items-start gap-2 py-1 text-xs tabular-nums",
            usage.rateLimitReachedType ? "text-amber-600" : "text-muted-foreground",
          )}
          aria-label={`Codex usage: ${presentation.summary}`}
          data-codex-usage-model={usage.model}
        >
          <GaugeIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="block font-medium text-foreground/90">Codex usage</span>
            <span className="mt-0.5 block whitespace-pre-line leading-4">
              {presentation.details}
            </span>
          </span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});
