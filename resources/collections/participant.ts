import {
  type CollectionDefinition,
  defineCollection,
} from "@/database/collections/index.ts";

/** Native graph participant. Thread membership is represented only by edges. */
export default defineCollection({
  name: "participant",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      externalId: { type: "string" },
      participantType: {
        type: "string",
        enum: ["human", "agent", "job"],
      },
      name: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      agentId: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["externalId", "participantType"],
  } as const,
  keys: [{ property: "externalId" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: ["externalId", "participantType", "agentId"],
}) as CollectionDefinition;
