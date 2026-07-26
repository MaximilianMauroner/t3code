import type { DispatchableClientOrchestrationCommand } from "@t3tools/contracts";

export type ExternalCommandEffect = "hot" | "pure";
type ExternalCommandType = DispatchableClientOrchestrationCommand["type"];

/** Adding an external command is a compile error until its lifecycle behavior is chosen here. */
export const externalCommandEffects = {
  "project.create": "pure",
  "project.meta.update": "pure",
  "project.delete": "pure",
  "thread.create": "pure",
  "thread.delete": "hot",
  "thread.archive": "hot",
  "thread.unarchive": "pure",
  "thread.settle": "pure",
  "thread.unsettle": "pure",
  "thread.snooze": "pure",
  "thread.unsnooze": "pure",
  "thread.meta.update": "pure",
  "thread.runtime-mode.set": "hot",
  "thread.interaction-mode.set": "pure",
  "thread.turn.start": "hot",
  "thread.turn.interrupt": "hot",
  "thread.approval.respond": "hot",
  "thread.user-input.respond": "hot",
  "thread.checkpoint.revert": "hot",
  "thread.session.stop": "hot",
} satisfies Record<ExternalCommandType, ExternalCommandEffect>;

export function classifyExternalCommand(
  command: DispatchableClientOrchestrationCommand,
): ExternalCommandEffect {
  return externalCommandEffects[command.type];
}
