/** Defines one independently mutable durable Tool-plan branch cursor. @module */

import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections/authoring";
import { metadataSchema, timestampsSchema } from "../../shared/schema.ts";

export const toolPlanBranchCollection: CollectionDefinition = defineCollection({
  name: "toolPlanBranch",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      planId: { type: "string" },
      branchIndex: { type: "integer", minimum: 0 },
      state: { type: "object" },
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "planId",
      "branchIndex",
      "state",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { metadata: {} },
  indexes: [["planId", "branchIndex"]],
  commands: {
    /** Emits one independent durable event for this branch's current cursor. */
    stageReady: {
      event: "tool_plan_branch.stage-ready",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const stageIndex = Number(data.stageIndex);
        if (
          Number(current.branchIndex) !== Number(data.branchIndex) ||
          state.status !== "ready" || Number(state.stageIndex) !== stageIndex
        ) return;
        state.readyEvent = Number(state.readyEvent ?? 0) + 1;
        return { set: { state } };
      },
    },
    /** Event-id ownership CAS. The same delivery may safely re-enter. */
    claimStage: {
      event: "tool_plan_branch.stage-claimed",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const stageIndex = Number(data.stageIndex);
        const owner = String(data.owner ?? "");
        if (!owner || Number(state.stageIndex) !== stageIndex) return;
        if (state.status === "running" && state.owner === owner) {
          return { set: { state } };
        }
        if (state.status !== "ready") return;
        state.status = "running";
        state.owner = owner;
        return { set: { state } };
      },
    },
    /** CAS settles this branch stage with its immutable result-record id. */
    settleStage: {
      event: "tool_plan_branch.stage-settled",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const stageIndex = Number(data.stageIndex);
        const resultId = String(data.resultId ?? "");
        if (
          !resultId || state.status !== "running" ||
          Number(state.stageIndex) !== stageIndex
        ) return;
        state.resultId = resultId;
        state.status = "settled-stage";
        delete state.owner;
        return { set: { state } };
      },
    },
    /** Advances this branch, skips descendants, or marks it finally settled. */
    advanceBranch: {
      event: "tool_plan_branch.advanced",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const from = Number(data.fromStageIndex);
        if (
          state.status !== "settled-stage" ||
          Number(state.stageIndex) !== from
        ) return;
        const resultId =
          typeof data.resultId === "string" && data.resultId.trim()
            ? data.resultId.trim()
            : typeof state.resultId === "string"
            ? state.resultId
            : "";
        if (!resultId) {
          throw new TypeError("Tool-plan branch result reference is required.");
        }
        state.resultId = resultId;
        if (data.done === true) {
          state.status = "settled";
          state.finalResultId = resultId;
          delete state.resultId;
        } else {
          const next = Number(data.stageIndex);
          if (!Number.isSafeInteger(next) || next < 0) {
            throw new TypeError("Tool-plan stage cursor is invalid.");
          }
          state.stageIndex = next;
          state.status = "ready";
          delete state.owner;
        }
        return { set: { state } };
      },
    },
  },
});

export default toolPlanBranchCollection;
