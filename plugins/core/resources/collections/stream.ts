import {
  defineCollection,
  relation,
  type CollectionDefinition,
} from "@copilotz/copilotz/collections";
import { timestampsSchema } from "./schema.ts";

/**
 * Stream is defined in Phase 3 so Phase 4 can register it. There is no writer
 * here. Phase 8 owns body-store streaming and connecting this collection.
 */
export const streamCollection: CollectionDefinition = defineCollection({
  name: "stream",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      lane: { type: "string" },
      mediaType: { type: "string" },
      state: {
        type: "string",
        enum: ["open", "closed", "failed", "abandoned"],
      },
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "state",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { state: "open" },
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_stream"),
  },
});
