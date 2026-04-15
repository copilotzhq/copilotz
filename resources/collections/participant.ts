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
});
