/** Defines asset-backed terminal results for Core Tool-plan stages. @module */

import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  timestampsSchema,
} from "../internal/schema.ts";

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
