/**
 * Participant collection: human users and agent participants in conversations.
 * Replaces the deprecated relational `users` table.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";

export default defineCollection({
  name: "participant",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      externalId: { type: "string" },
      participantType: {
        type: "string",
        enum: ["human", "agent"],
        description: "Whether this participant is a human user or an AI agent",
      },
      name: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      agentId: {
        type: ["string", "null"],
        description: "Agent ID (only for agent participants)",
      },
      metadata: { type: ["object", "null"] },
      isGlobal: {
        type: ["boolean", "null"],
        description: "Whether this participant exists across all namespaces",
      },
    },
    required: ["externalId", "participantType"],
  } as const,
  keys: [{ property: "externalId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "externalId",
    "participantType",
  ],
  relations: {
    sentMessages: relation.hasMany("message", "senderId", "SENT_BY"),
  },
  methods: ({ collection, rootCollections, namespace }) => ({
    async getByExternalId(externalId: string) {
      return await collection.findOne({ externalId });
    },

    async resolveByExternalId(externalId: string) {
      const local = await collection.findOne({ externalId });
      if (local || namespace === "global") return local;
      const globalParticipant = (rootCollections as {
        withNamespace: (namespace: string) => {
          participant?: typeof collection;
        };
      }).withNamespace("global").participant;
      if (!globalParticipant || typeof globalParticipant.findOne !== "function") {
        return null;
      }
      return await globalParticipant.findOne({ externalId });
    },

    async upsertIdentity(input: {
      id?: string;
      externalId: string;
      participantType: "human" | "agent";
      name?: string | null;
      email?: string | null;
      agentId?: string | null;
      metadata?: Record<string, unknown> | null;
      isGlobal?: boolean | null;
    }) {
      return await collection.upsert(
        { externalId: input.externalId },
        {
          ...(input.id ? { id: input.id } : {}),
          externalId: input.externalId,
          participantType: input.participantType,
          name: input.name ?? null,
          email: input.email ?? null,
          agentId: input.agentId ?? null,
          metadata: input.metadata ?? null,
          isGlobal: input.isGlobal ?? (namespace === "global"),
        },
      );
    },
  }),
});
