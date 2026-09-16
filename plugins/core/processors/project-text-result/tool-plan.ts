import { actionCallerDefinitionId } from "@copilotz/copilotz/actions";
import type { LlmToolCall } from "@copilotz/copilotz/llm";
import {
  coreAgent,
  type CoreToolProcessorContext,
} from "../../shared/runtime-context.ts";
import { toolsForAgent } from "../../shared/helpers.ts";
import {
  calls,
  type CoreToolPlanBase,
  stages,
} from "../../shared/tool-plan.ts";

function available(
  context: CoreToolProcessorContext,
  base: Pick<CoreToolPlanBase, "agentId" | "availableToolIds">,
  planCalls: readonly LlmToolCall[],
) {
  const agent = coreAgent(context.resources, base.agentId);
  if (!agent) throw new Error(`Unknown agent '${base.agentId}'.`);
  const tools = toolsForAgent(context, agent);
  const ids = tools.map((tool) => tool.alias);
  if (
    ids.length !== base.availableToolIds.length ||
    ids.some((id, i) => id !== base.availableToolIds[i])
  ) throw new Error("Tool grants changed while plan was running.");
  const granted = new Set(ids);
  for (const call of planCalls) {
    for (const stage of stages(call)) {
      if (
        stage.type === "tool" &&
        (!granted.has(stage.action) ||
          typeof context.actions[stage.action] !== "function")
      ) throw new Error(`Tool Action '${stage.action}' is unavailable.`);
    }
  }
}

export function validateCoreToolPlan(
  context: CoreToolProcessorContext,
  input: Readonly<
    {
      agentId: string;
      availableToolIds: readonly string[];
      calls: readonly LlmToolCall[];
    }
  >,
): readonly LlmToolCall[] {
  const result = calls(input.calls);
  available(context, input, result);
  return result;
}

export function snapshotToolStageHistory(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly (readonly (string | null)[])[] {
  return (planCalls.map((
    call,
  ) => (stages(call).map((stage) =>
    stage.type === "tool"
      ? context.resources.tools[stage.action]?.history?.visibility ?? null
      : null
  ))));
}

export function snapshotToolStageActionIds(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly (readonly (string | null)[])[] {
  return (planCalls.map((call) => (stages(call).map((stage) => {
    if (stage.type !== "tool") return null;
    const actionId = actionCallerDefinitionId(
      context.actions[stage.action],
    );
    if (!actionId) {
      throw new Error(
        `Tool Action '${stage.action}' has no registered definition identity.`,
      );
    }
    return actionId;
  }))));
}

export function snapshotRootTools(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly Readonly<{ alias: string; name: string }>[] {
  return (planCalls.map((call) => {
    const tool = context.resources.tools[call.action];
    if (!tool) {
      throw new Error(`Tool Resource '${call.action}' is unavailable.`);
    }
    return ({ alias: call.action, name: tool.name } as const);
  }));
}
