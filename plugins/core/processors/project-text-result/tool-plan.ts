import { actionCallerDefinitionId } from "@copilotz/copilotz/actions";
import type { LlmToolCall } from "@copilotz/copilotz/llm";
import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import { stages } from "../../shared/tool-plan.ts";

export function snapshotToolStageHistory(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
  availableToolIds: readonly string[],
): readonly (readonly (string | null)[])[] {
  const advertised = new Set(availableToolIds);
  return (planCalls.map((
    call,
  ) => (stages(call).map((stage) =>
    stage.type === "tool" && advertised.has(stage.action)
      ? context.resources.tools[stage.action]?.history?.visibility ?? null
      : null
  ))));
}

export function snapshotToolStageActionIds(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
  availableToolIds: readonly string[],
): readonly (readonly (string | null)[])[] {
  const advertised = new Set(availableToolIds);
  return (planCalls.map((call) => (stages(call).map((stage) => {
    // An unadvertised or absent Action stays unavailable even if composition
    // later adds it. Stage dispatch projects the normal ToolUnavailable result.
    if (stage.type !== "tool" || !advertised.has(stage.action)) return null;
    return actionCallerDefinitionId(context.actions[stage.action]) ?? null;
  }))));
}

export function snapshotRootTools(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
  availableToolIds: readonly string[],
): readonly Readonly<{ alias: string; name: string }>[] {
  const advertised = new Set(availableToolIds);
  return (planCalls.map((call) => {
    const tool = advertised.has(call.action)
      ? context.resources.tools[call.action]
      : undefined;
    return ({ alias: call.action, name: tool?.name ?? call.action } as const);
  }));
}
