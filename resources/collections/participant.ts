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
  methods: ({ collection, rootCollections, namespace }) => {
    // Store references to base CRUD methods to avoid infinite recursion
    const base = {
      create: collection.create.bind(collection),
      findOne: collection.findOne.bind(collection),
      update: collection.update.bind(collection),
      upsert: collection.upsert.bind(collection),
      delete: collection.delete.bind(collection),
      count: collection.count.bind(collection),
    };

    const getIdentityNamespace = () => {
      if (namespace === "global") return "global";
      const threadMatch = namespace.match(/^(.*?)(?::thread:.*)?$/);
      return threadMatch ? threadMatch[1] : namespace;
    };

    const getIdentityCollection = (options?: any) => {
      const ns = options?.namespace || getIdentityNamespace();
      // If we are already in the target namespace, return the base collection
      // to avoid method-binding recursion.
      if (ns === namespace) return collection;
      return rootCollections.withNamespace(ns).participant;
    };

    return {
      // ----------------------------------------
      // WIDENED CRUD OVERRIDES
      // ----------------------------------------
      async findOne(filter: any, options?: any) {
        // If searching specifically by externalId, use resolution logic
        if (filter.externalId && Object.keys(filter).length === 1) {
          return await (this as any).resolveByExternalId(filter.externalId, options);
        }
        return await getIdentityCollection(options).findOne(filter, options);
      },

      async findById(id: string, options?: any) {
        return await (this as any).resolveByExternalId(id, options);
      },

      async create(data: any, options?: any) {
        const targetColl = getIdentityCollection(options);
        const createMethod = targetColl === collection ? base.create : targetColl.create;
        return await createMethod(data, options);
      },

      async update(filter: any, data: any, options?: any) {
        const targetColl = getIdentityCollection(options);
        const updateMethod = targetColl === collection ? base.update : targetColl.update;
        return await updateMethod(filter, data, options);
      },

      async upsert(filter: any, data: any, options?: any) {
        return await getIdentityCollection(options).upsert(filter, data, options);
      },

      async delete(filter: any, options?: any) {
        const targetColl = getIdentityCollection(options);
        const deleteMethod = targetColl === collection ? base.delete : targetColl.delete;
        return await deleteMethod(filter, options);
      },

      async count(filter: any, options?: any) {
        const targetColl = getIdentityCollection(options);
        const countMethod = targetColl === collection ? base.count : targetColl.count;
        return await countMethod(filter, options);
      },

      // ----------------------------------------
      // CUSTOM IDENTITY METHODS
      // ----------------------------------------
      async getByExternalId(externalId: string, options?: any) {
        const idNamespace = getIdentityNamespace();
        const identityParticipant = rootCollections.withNamespace(idNamespace).participant;
        // Use identityParticipant directly - if it's 'this' namespace, the 
        // findOne check below handles the base call.
        return await (this as any).findOne({ externalId }, options);
      },

      async resolveByExternalId(id: string, options?: any) {
        const idNamespace = getIdentityNamespace();
        
        // 1. Try local namespace (widened) by External ID
        // Note: we use base.findOne if we are looking in our own namespace to break recursion
        const localColl = getIdentityCollection(options);
        let record = await (localColl === collection 
          ? base.findOne({ externalId: id }, options) 
          : localColl.findOne({ externalId: id }, options));
        
        // 2. If not found and looks like a ULID, try by ID
        if (!record && id.length >= 26) {
          record = await (localColl === collection 
            ? base.findOne({ id }, options) 
            : localColl.findOne({ id }, options));
        }

        if (record || idNamespace === "global") return record;
        
        // 3. Fallback to global namespace
        const globalParticipant = rootCollections.withNamespace("global").participant;
        if (!globalParticipant || typeof globalParticipant.findOne !== "function") {
          return null;
        }
        
        // Use the global collection's findOne (which might have its own widening, that's fine)
        record = await globalParticipant.findOne({ externalId: id }, options);
        if (!record && id.length >= 26) {
          record = await globalParticipant.findOne({ id }, options);
        }
        return record;
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
      }, options?: any) {
        const targetColl = getIdentityCollection(options);
        const upsertMethod = targetColl === collection ? base.upsert : targetColl.upsert;
        
        return await upsertMethod(
          { externalId: input.externalId },
          {
            ...(input.id ? { id: input.id } : {}),
            externalId: input.externalId,
            participantType: input.participantType,
            name: input.name ?? null,
            email: input.email ?? null,
            agentId: input.agentId ?? null,
            metadata: input.metadata ?? null,
            isGlobal: input.isGlobal ?? (getIdentityNamespace() === "global"),
          },
          options,
        );
      },
    };
  },
});
