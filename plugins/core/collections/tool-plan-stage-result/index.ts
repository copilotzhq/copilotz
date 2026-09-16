/** Defines asset-backed terminal results for Core Tool-plan stages. @module */

import { contentSequenceSchema } from "@copilotz/copilotz/content";
import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { metadataSchema, timestampsSchema } from "../../shared/schema.ts";

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

export default toolPlanStageResultCollection;
