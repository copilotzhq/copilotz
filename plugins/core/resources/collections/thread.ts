import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { metadataSchema, timestampsSchema } from "./schema.ts";

export const threadCollection: CollectionDefinition = defineCollection({
  name: "thread",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      externalId: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
      parentThreadId: { type: "string" },
      metadata: metadataSchema,
      participantIds: {
        type: "array",
        items: { type: "string" },
      },
      activeMessageBranch: {
        type: "object",
        additionalProperties: false,
        properties: {
          rootMessageId: { type: "string" },
          headMessageId: { type: "string" },
          previousRevisionMessageId: { type: "string" },
          revisionIndex: { type: "integer" },
        },
        required: [
          "rootMessageId",
          "headMessageId",
          "previousRevisionMessageId",
          "revisionIndex",
        ],
      },
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "status",
      "metadata",
      "participantIds",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    status: "active",
    metadata: {},
    participantIds: [],
  },
  identity: {
    sourceType: "thread_external_id",
    sourceField: "externalId",
  },
  search: { enabled: true, fields: ["name", "description"] },
  relations: {
    participants: relation.hasMany(
      "participant",
      "participantIds",
      "participates_in",
      "child-to-parent",
    ),
    parent: relation.belongsTo("thread", "parentThreadId", "has_child_thread"),
  },
  queries: {
    byExternalId: {
      filter({ input }) {
        return { externalId: String(input.externalId ?? "") };
      },
    },
  },
  commands: {
    addParticipant: {
      mutate({ current, input }) {
        const participantId = typeof (input as Record<string, unknown>)
            .participantId === "string"
          ? String((input as Record<string, unknown>).participantId).trim()
          : "";
        if (!participantId) {
          throw new TypeError("Participant ID must be non-empty.");
        }
        const currentIds = Array.isArray(current.participantIds)
          ? current.participantIds.filter((value): value is string =>
            typeof value === "string"
          )
          : [];
        if (currentIds.includes(participantId)) return undefined;
        return {
          set: {
            participantIds: [...new Set([...currentIds, participantId])],
          },
        };
      },
    },
  },
});
