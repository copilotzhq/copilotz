import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../context.ts";
import {
  advanceCompletedToolMembers,
  dispatchReadyStage,
  projectDurableToolPlan,
  scheduleReadyBranches,
} from "../../internal/tool-plan.ts";
import { asRecord, collectionEventRecord } from "./helpers.ts";

async function withToolPlanConflictRetry(
  context: CoreToolProcessorContext,
  operation: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0;; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const stale = error instanceof Error &&
        error.message.includes("changed while its mutation was prepared");
      if (!stale || attempt >= 32 || context.signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function stageReadyCursor(
  event: { data: unknown },
  record: { id: string },
): Readonly<{ branchIndex: number; stageIndex: number }> {
  const intent = asRecord(asRecord(event.data).intent);
  if (
    intent.operation !== "command" || intent.name !== "stageReady" ||
    intent.id !== record.id
  ) {
    throw new Error(
      "Tool-plan stage-ready event has an invalid command intent.",
    );
  }
  const input = intent.input;
  if (
    !Array.isArray(input) || input.length !== 2 || input[0] !== "object" ||
    !Array.isArray(input[1]) || input[1].length !== 2
  ) throw new Error("Tool-plan stage-ready input is invalid.");
  const values = new Map<string, number>();
  for (const pair of input[1]) {
    if (
      !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== "string" || !Array.isArray(pair[1]) ||
      pair[1].length !== 2 || pair[1][0] !== "number" ||
      typeof pair[1][1] !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(pair[1][1])
    ) throw new Error("Tool-plan stage-ready cursor is invalid.");
    const value = Number(pair[1][1]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Tool-plan stage-ready cursor is invalid.");
    }
    values.set(pair[0], value);
  }
  if (
    values.size !== 2 || !values.has("branchIndex") || !values.has("stageIndex")
  ) throw new Error("Tool-plan stage-ready cursor fields are invalid.");
  return {
    branchIndex: values.get("branchIndex")!,
    stageIndex: values.get("stageIndex")!,
  };
}

/**
 * Each durable ready event owns precisely one dispatcher.  State transitions
 * only schedule events; they never call Actions inline.
 */
export const toolPlanCoordinatorProcessor: Processor<CoreToolProcessorContext> =
  defineProcessor<CoreToolProcessorContext>({
    id: "copilotz.core.tool-plan-coordinator",
    on: [
      { eventType: "toolPlan.created" },
      { eventType: "tool_plan.stage-ready" },
      { eventType: "tool_plan.stage-settled" },
      { eventType: "tool_plan.projection-ready" },
    ],
    async handle(event, context) {
      if (!event.durable) return;
      await withToolPlanConflictRetry(context, async () => {
        if (event.type === "toolPlan.created") {
          await scheduleReadyBranches(context, collectionEventRecord(event));
          return;
        }
        const record = collectionEventRecord(event);
        if (event.type === "tool_plan.stage-ready") {
          const cursor = stageReadyCursor(event, record);
          await dispatchReadyStage(
            context,
            event,
            record,
            cursor.branchIndex,
            cursor.stageIndex,
          );
          return;
        }
        if (event.type === "tool_plan.stage-settled") {
          const current = await context.collections.toolPlan?.get({
            id: String(record.id),
          });
          if (current) await advanceCompletedToolMembers(context, current);
          return;
        }
        await projectDurableToolPlan(context, event, record);
      });
    },
  });
