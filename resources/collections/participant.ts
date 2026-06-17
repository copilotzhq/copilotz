/**
 * Participant collection: human users and agent participants in conversations.
 * Replaces the deprecated relational `users` table.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

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
        description:
          "Whether this participant is a human user, AI agent, or job",
      },
      name: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      agentId: {
        type: ["string", "null"],
        description: "Agent ID (only for agent participants)",
      },
      metadata: { type: ["object", "null"] },
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
    sentMessages: relation.hasMany("message", "senderId", GRAPH_EDGE.SENT_BY),
  },
  methods: ({ collection }) => {
    // Store references to base CRUD methods to avoid infinite recursion
    const base = {
      create: collection.create.bind(collection),
      findOne: collection.findOne.bind(collection),
      update: collection.update.bind(collection),
      upsert: collection.upsert.bind(collection),
      delete: collection.delete.bind(collection),
      count: collection.count.bind(collection),
    };

    return {
      // ----------------------------------------
      // WIDENED CRUD OVERRIDES
      // ----------------------------------------
      async findOne(filter: any, options?: any) {
        // If searching specifically by externalId, use resolution logic
        if (filter.externalId && Object.keys(filter).length === 1) {
          return await (this as any).resolveByExternalId(
            filter.externalId,
            options,
          );
        }
        return await base.findOne(filter, options);
      },

      async findById(id: string, options?: any) {
        return await (this as any).resolveByExternalId(id, options);
      },

      async create(data: any, options?: any) {
        void options;
        return await base.create(data);
      },

      async update(filter: any, data: any, options?: any) {
        void options;
        return await base.update(filter, data);
      },

      async upsert(filter: any, data: any, options?: any) {
        void options;
        return await base.upsert(filter, data);
      },

      async delete(filter: any, options?: any) {
        void options;
        return await base.delete(filter);
      },

      async count(filter: any, options?: any) {
        void options;
        return await base.count(filter);
      },

      // ----------------------------------------
      // CUSTOM IDENTITY METHODS
      // ----------------------------------------
      async getByExternalId(externalId: string, options?: any) {
        return await (this as any).findOne({ externalId }, options);
      },

      async resolveByExternalId(id: string, options?: any) {
        let record = await base.findOne({ externalId: id }, options);

        if (!record && id.length >= 26) {
          record = await base.findOne({ id }, options);
        }

        return record ?? null;
      },

      async upsertIdentity(input: {
        id?: string;
        externalId: string;
        participantType: "human" | "agent" | "job";
        name?: string | null;
        email?: string | null;
        agentId?: string | null;
        metadata?: Record<string, unknown> | null;
      }, options?: any) {
        return await base.upsert(
          { externalId: input.externalId },
          {
            ...(input.id ? { id: input.id } : {}),
            externalId: input.externalId,
            participantType: input.participantType,
            name: input.name ?? null,
            email: input.email ?? null,
            agentId: input.agentId ?? null,
            metadata: input.metadata ?? null,
          },
        );
      },
    };
  },
});
