/**
 * Persists the mapping between provider threads and Core threads.
 *
 * @module
 */

import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";

export const CHANNEL_BINDING_COLLECTION = "channel_binding";

const channelBindingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    channelId: { type: "string" },
    externalThreadId: { type: "string" },
    threadId: { type: "string" },
    inboundMessageId: { type: "string" },
    route: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "channelId",
    "externalThreadId",
    "threadId",
    "inboundMessageId",
    "route",
    "metadata",
  ],
} as const;

export const channelBindingCollection: CollectionDefinition<
  typeof channelBindingSchema
> = defineCollection({
  name: CHANNEL_BINDING_COLLECTION,
  schema: channelBindingSchema,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  defaults: { route: {}, metadata: {} },
  indexes: [
    "threadId",
    "inboundMessageId",
    { fields: ["channelId", "externalThreadId"], unique: true },
  ],
  relations: {
    thread: relation.belongsTo("thread", "threadId", "bound_to_channel"),
  },
  queries: {
    byChannelThread: {
      filter({ input }) {
        return {
          channelId: String(input.channelId ?? ""),
          externalThreadId: String(input.externalThreadId ?? ""),
        };
      },
    },
    byThreadId: {
      filter({ input }) {
        return { threadId: String(input.threadId ?? "") };
      },
    },
  },
});
