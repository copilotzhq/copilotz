/** Defines the durable Core Tool-plan projection barrier Collection. @module */

import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections/authoring";
import { metadataSchema, timestampsSchema } from "../../shared/schema.ts";

/** Immutable provider-plan facts plus the single ordered projection barrier. */
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
    /** Converts a pre-release shared-cursor plan after its branch rows exist. */
    migrateLegacyBranches: {
      mutate({ current }) {
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (state.layoutVersion === 2) return;
        if (!Array.isArray(state.branches)) {
          throw new TypeError("Legacy Tool-plan branch state is invalid.");
        }
        const branchCount = state.branches.length;
        delete state.branches;
        state.layoutVersion = 2;
        state.branchCount = branchCount;
        return { set: { state } };
      },
    },
    /** Opens the final projection barrier after every branch has settled. */
    projectionReady: {
      event: "tool_plan.projection-ready",
      mutate({ current }) {
        const state = structuredClone(current.state) as Record<string, unknown>;
        if (
          state.layoutVersion !== 2 ||
          (state.status !== "running" && state.status !== "ready") ||
          Number(state.projectionReadyEvent ?? 0) > 0
        ) return;
        state.status = "ready";
        state.projectionReadyEvent = 1;
        return { set: { state } };
      },
    },
    /** Event-id ownership CAS. The same delivery may safely re-enter. */
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

export default toolPlanCollection;
