import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  timestampsSchema,
} from "./schema.ts";

/**
 * Mutable coordination for one provider response.  Deliberately contains no
 * tool input, output, error, or jq accumulator: those are immutable assets in
 * `toolPlanStageResult` and referenced here by id only.
 */
export const toolPlanCollection: CollectionDefinition = defineCollection({
  name: "toolPlan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      planMessageId: { type: "string" },
      state: { type: "object" },
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "planMessageId",
      "state",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { metadata: {} },
  indexes: ["planMessageId", "threadId"],
  commands: {
    /** Emits one independent durable event for a branch's current cursor. */
    stageReady: {
      event: "tool_plan.stage-ready",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const branches = Array.isArray(state.branches) ? state.branches : [];
        const index = Number(data.branchIndex),
          stageIndex = Number(data.stageIndex);
        const branch = branches[index] as Record<string, unknown> | undefined;
        if (
          !branch || state.status !== "running" || branch.status !== "ready" ||
          Number(branch.stageIndex) !== stageIndex
        ) return;
        branch.readyEvent = Number(branch.readyEvent ?? 0) + 1;
        return { set: { state } };
      },
    },
    /** Event-id ownership CAS.  The same delivery may safely re-enter. */
    claimStage: {
      event: "tool_plan.stage-claimed",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const branches = Array.isArray(state.branches) ? state.branches : [];
        const index = Number(data.branchIndex),
          stageIndex = Number(data.stageIndex),
          owner = String(data.owner ?? "");
        const branch = branches[index] as Record<string, unknown> | undefined;
        if (
          !owner || !branch || state.status !== "running" ||
          Number(branch.stageIndex) !== stageIndex
        ) return;
        if (branch.status === "running" && branch.owner === owner) {
          return { set: { state } };
        }
        if (branch.status !== "ready") return;
        branch.status = "running";
        branch.owner = owner;
        return { set: { state } };
      },
    },
    /** CAS settles one action stage with an immutable result-record reference. */
    settleStage: {
      event: "tool_plan.stage-settled",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        const branches = Array.isArray(state.branches) ? state.branches : [];
        const index = Number(data.branchIndex),
          stageIndex = Number(data.stageIndex),
          resultId = String(data.resultId ?? "");
        const branch = branches[index] as Record<string, unknown> | undefined;
        if (
          !resultId || !branch || state.status !== "running" ||
          branch.status !== "running" ||
          Number(branch.stageIndex) !== stageIndex
        ) return;
        branch.resultId = resultId;
        branch.status = "settled-stage";
        delete branch.owner;
        return { set: { state } };
      },
    },
    /** Advances to a tool stage, skips descendants, or opens the final barrier. */
    advanceBranch: {
      event: "tool_plan.branch-advanced",
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (state.status !== "running") return;
        const branches = Array.isArray(state.branches) ? state.branches : [];
        const index = Number(data.branchIndex),
          from = Number(data.fromStageIndex);
        const branch = branches[index] as Record<string, unknown> | undefined;
        if (
          !branch || branch.status !== "settled-stage" ||
          Number(branch.stageIndex) !== from
        ) return;
        const resultId =
          typeof data.resultId === "string" && data.resultId.trim()
            ? data.resultId.trim()
            : typeof branch.resultId === "string"
            ? branch.resultId
            : "";
        if (!resultId) {
          throw new TypeError("Tool-plan branch result reference is required.");
        }
        branch.resultId = resultId;
        if (data.done === true) {
          branch.status = "settled";
          branch.finalResultId = resultId;
          delete branch.resultId;
        } else {
          const next = Number(data.stageIndex);
          if (!Number.isSafeInteger(next) || next < 0) {
            throw new TypeError("Tool-plan stage cursor is invalid.");
          }
          branch.stageIndex = next;
          branch.status = "ready";
          delete branch.owner;
        }
        if (
          branches.every((candidate) =>
            (candidate as Record<string, unknown>).status === "settled"
          )
        ) state.status = "ready";
        return { set: { state } };
      },
    },
    projectionReady: {
      event: "tool_plan.projection-ready",
      mutate({ current }) {
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (state.status !== "ready") return;
        state.projectionReadyEvent = Number(state.projectionReadyEvent ?? 0) +
          1;
        return { set: { state } };
      },
    },
    claimProjection: {
      event: "tool_plan.projection-claimed",
      mutate({ current, input }) {
        const owner = String((input as Record<string, unknown>).owner ?? "");
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (!owner) throw new TypeError("Projection owner is required.");
        if (state.status === "projecting" && state.projectionOwner === owner) {
          return { set: { state } };
        }
        if (state.status !== "ready") return;
        state.status = "projecting";
        state.projectionOwner = owner;
        return { set: { state } };
      },
    },
    finishProjection: {
      event: "tool_plan.projected",
      mutate({ current, input }) {
        const owner = String((input as Record<string, unknown>).owner ?? "");
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (state.status !== "projecting" || state.projectionOwner !== owner) {
          return;
        }
        state.status = "projected";
        return { set: { state } };
      },
    },
  },
});

/** One exact JSON terminal envelope, assetized through the declared content field. */
export const toolPlanStageResultCollection: CollectionDefinition =
  defineCollection({
    name: "toolPlanStageResult",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        planId: { type: "string" },
        branchIndex: { type: "integer" },
        stageIndex: { type: "integer" },
        content: contentSequenceSchema,
        metadata: metadataSchema,
        ...timestampsSchema,
      },
      required: [
        "id",
        "namespace",
        "planId",
        "branchIndex",
        "stageIndex",
        "content",
        "metadata",
        "createdAt",
        "updatedAt",
      ],
    } as const,
    defaults: { content: [], metadata: {} },
    content: { fields: ["content"] },
    indexes: ["planId", ["planId", "branchIndex", "stageIndex"]],
  });
