/** Defines the canonical Core Participant Collection. @module */

import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { metadataSchema, timestampsSchema } from "../internal/schema.ts";

export const participantCollection: CollectionDefinition = defineCollection({
  name: "participant",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      externalId: { type: "string" },
      participantType: {
        type: "string",
        enum: ["human", "agent", "tool", "job"],
      },
      name: { type: "string" },
      email: { type: "string" },
      agentId: { type: "string" },
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "externalId",
      "participantType",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { metadata: {} },
  identity: {
    sourceType: "participant_external_id",
    sourceField: "externalId",
  },
  search: { enabled: true, fields: ["name", "externalId"] },
  queries: {
    byExternalId: {
      filter({ input }) {
        return { externalId: String(input.externalId ?? "") };
      },
    },
  },
});
