/** Coordinates durable Tool-plan branch dispatch and final fan-in. @module */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import {
  advanceCompletedToolMembers,
  dispatchReadyStage,
  projectDurableToolPlan,
  scheduleReadyBranches,
} from "../../shared/tool-plan.ts";
import { asRecord, collectionEventRecord } from "../../shared/helpers.ts";

type Cursor = Readonly<{ branchIndex: number; stageIndex: number }>;

function commandNumbers(
  event: { data: unknown },
  record: { id: string },
  command: string,
): ReadonlyMap<string, number> {
  const intent = asRecord(asRecord(event.data).intent);
  if (
    intent.operation !== "command" || intent.name !== command ||
    intent.id !== record.id
  ) {
    throw new Error(
      `Tool-plan ${command} event has an invalid command intent.`,
    );
  }
  const input = intent.input;
  if (
    !Array.isArray(input) || input.length !== 2 || input[0] !== "object" ||
    !Array.isArray(input[1])
  ) throw new Error(`Tool-plan ${command} input is invalid.`);
  const values = new Map<string, number>();
  for (const pair of input[1]) {
    if (
      !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== "string" || !Array.isArray(pair[1]) ||
      pair[1].length !== 2
    ) throw new Error(`Tool-plan ${command} input is invalid.`);
    if (pair[1][0] === "number") {
      if (
        typeof pair[1][1] !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/.test(pair[1][1])
      ) {
        throw new Error(`Tool-plan ${command} cursor is invalid.`);
      }
      const value = Number(pair[1][1]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Tool-plan ${command} cursor is invalid.`);
      }
      values.set(pair[0], value);
    } else if (pair[1][0] !== "string" || typeof pair[1][1] !== "string") {
      throw new Error(`Tool-plan ${command} input is invalid.`);
    }
  }
  return values;
}

function stageReadyCursor(
  event: { data: unknown },
  record: { id: string },
): Cursor {
  const values = commandNumbers(event, record, "stageReady");
  if (
    values.size !== 2 || !values.has("branchIndex") ||
    !values.has("stageIndex")
  ) throw new Error("Tool-plan stage-ready cursor fields are invalid.");
  return {
    branchIndex: values.get("branchIndex")!,
    stageIndex: values.get("stageIndex")!,
  };
}

function stageReadyIndex(
  event: { data: unknown },
  record: { id: string },
): number {
  const values = commandNumbers(event, record, "stageReady");
  const stageIndex = values.get("stageIndex");
  if (stageIndex === undefined) {
    throw new Error("Tool-plan stage-ready event has no stage cursor.");
  }
  return stageIndex;
}

function settledBranchIndex(
  event: { data: unknown },
  record: { id: string },
): number {
  const values = commandNumbers(event, record, "settleStage");
  const branchIndex = values.get("branchIndex");
  if (branchIndex === undefined) {
    throw new Error("Legacy Tool-plan settlement has no branch cursor.");
  }
  return branchIndex;
}

async function planForBranch(
  context: CoreToolProcessorContext,
  branchId: string,
): Promise<Readonly<{ plan: CollectionRecord; branchIndex: number }>> {
  const branch = await context.collections.toolPlanBranch?.get({
    id: branchId,
  });
  if (!branch) throw new Error(`Tool-plan branch '${branchId}' was not found.`);
  const plan = await context.collections.toolPlan?.get({
    id: String(branch.planId),
  });
  if (!plan) throw new Error(`Tool plan '${branch.planId}' was not found.`);
  return { plan, branchIndex: Number(branch.branchIndex) };
}

/**
 * Branch events mutate one branch record. Legacy flat-plan events remain
 * accepted while pre-release in-flight plans and their deliveries are drained.
 */
export const toolPlanCoordinatorProcessor: Processor<CoreToolProcessorContext> =
  defineProcessor<CoreToolProcessorContext>({
    id: "copilotz.core.tool-plan-coordinator",
    on: [
      { eventType: "toolPlan.created" },
      { eventType: "tool_plan.stage-ready" },
      { eventType: "tool_plan.stage-settled" },
      { eventType: "tool_plan.projection-ready" },
      { eventType: "tool_plan_branch.stage-ready" },
      { eventType: "tool_plan_branch.stage-settled" },
    ],
    async handle(event, context) {
      if (!event.durable) return;
      const record = collectionEventRecord(event);
      if (event.type === "toolPlan.created") {
        await scheduleReadyBranches(context, record);
        return;
      }
      if (
        event.type === "tool_plan.stage-ready" ||
        event.type === "tool_plan_branch.stage-ready"
      ) {
        if (event.type === "tool_plan.stage-ready") {
          const cursor = stageReadyCursor(event, record);
          const plan = await context.collections.toolPlan?.get({
            id: String(record.id),
          });
          if (plan) {
            await dispatchReadyStage(
              context,
              event,
              plan,
              cursor.branchIndex,
              cursor.stageIndex,
            );
          }
          return;
        }
        const stageIndex = stageReadyIndex(event, record);
        const target = await planForBranch(context, String(record.id));
        await dispatchReadyStage(
          context,
          event,
          target.plan,
          target.branchIndex,
          stageIndex,
        );
        return;
      }
      if (
        event.type === "tool_plan.stage-settled" ||
        event.type === "tool_plan_branch.stage-settled"
      ) {
        if (event.type === "tool_plan.stage-settled") {
          const branchIndex = settledBranchIndex(event, record);
          const plan = await context.collections.toolPlan?.get({
            id: String(record.id),
          });
          if (plan) {
            await advanceCompletedToolMembers(context, plan, branchIndex);
          }
          return;
        }
        const target = await planForBranch(context, String(record.id));
        await advanceCompletedToolMembers(
          context,
          target.plan,
          target.branchIndex,
        );
        return;
      }
      await projectDurableToolPlan(context, event, record);
    },
  });

export default toolPlanCoordinatorProcessor;
