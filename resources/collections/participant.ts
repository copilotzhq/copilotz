/**
 * Participant collection: human users and agent participants in conversations.
 * Replaces the deprecated relational `users` table.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";
import type { DatabaseOperations } from "@/database/operations/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import { ulid } from "ulid";

type ParticipantNodeRow = {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: Record<string, unknown> | null;
  source_type: string | null;
  source_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapParticipantNode(row: ParticipantNodeRow): Record<string, unknown> {
  return {
    ...(row.data ?? {}),
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepMergeReplaceArrays(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMergeReplaceArrays(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

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
  methods: ({ collection, namespace, ops }) => {
    const databaseOps = ops as DatabaseOperations;
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
        void options;
        const externalId = input.externalId.trim();
        if (!externalId) {
          throw new Error("Participant externalId is required");
        }

        return await databaseOps.transaction(async (transactionOps) => {
          const findIdentity = async () =>
            await transactionOps.query<ParticipantNodeRow>(
              `SELECT *
               FROM "nodes"
               WHERE "namespace" = $1
                 AND "type" = 'participant'
                 AND COALESCE("data" ->> 'externalId', "source_id") = $2
               ORDER BY "created_at" DESC, "id" DESC
               LIMIT 1
               FOR UPDATE`,
              [namespace, externalId],
            );

          let existingRow = (await findIdentity()).rows[0];
          if (!existingRow) {
            const now = new Date().toISOString();
            const id = input.id ?? ulid();
            const data = {
              id,
              externalId,
              participantType: input.participantType,
              name: input.name ?? null,
              email: input.email ?? null,
              agentId: input.agentId ?? null,
              metadata: input.metadata ?? null,
              createdAt: now,
              updatedAt: now,
            };
            const inserted = await transactionOps.query<ParticipantNodeRow>(
              `INSERT INTO "nodes" (
                "id", "namespace", "type", "name", "content", "data",
                "source_type", "source_id", "created_at", "updated_at"
               ) VALUES (
                $1, $2, 'participant', $3, NULL, $4, $5, $6, NOW(), NOW()
               )
               ON CONFLICT (
                 "namespace",
                 (COALESCE("data" ->> 'externalId', "source_id"))
               )
               WHERE
                 "type" = 'participant'
                 AND COALESCE("data" ->> 'externalId', "source_id") IS NOT NULL
                 AND COALESCE("data" ->> 'externalId', "source_id") <> ''
               DO NOTHING
               RETURNING *`,
              [
                id,
                namespace,
                input.name ?? externalId,
                data,
                input.participantType === "human"
                  ? "user"
                  : input.participantType,
                externalId,
              ],
            );
            if (inserted.rows[0]) {
              return mapParticipantNode(inserted.rows[0]);
            }

            existingRow = (await findIdentity()).rows[0];
            if (!existingRow) {
              throw new Error(`Failed to upsert participant: ${externalId}`);
            }
          }

          const existingData = existingRow.data ?? {};
          const existingMetadata = existingData.metadata &&
              typeof existingData.metadata === "object" &&
              !Array.isArray(existingData.metadata)
            ? existingData.metadata as Record<string, unknown>
            : null;
          const incomingMetadata = input.metadata &&
              typeof input.metadata === "object" &&
              !Array.isArray(input.metadata)
            ? input.metadata
            : null;
          const metadata = existingMetadata
            ? incomingMetadata
              ? deepMergeReplaceArrays(existingMetadata, incomingMetadata)
              : existingMetadata
            : incomingMetadata;
          const sourceType = input.participantType === "human"
            ? "user"
            : input.participantType;
          const nextData: Record<string, unknown> = {
            ...existingData,
            externalId,
            participantType: input.participantType,
            name: input.name ?? null,
            email: input.email ?? null,
            agentId: input.agentId ?? null,
            metadata,
          };
          const nodeName = input.name ?? externalId;
          const changed = !sameJsonValue(existingData, nextData) ||
            existingRow.name !== nodeName ||
            existingRow.source_type !== sourceType ||
            existingRow.source_id !== externalId;
          if (!changed) return mapParticipantNode(existingRow);

          nextData.updatedAt = new Date().toISOString();
          const updated = await transactionOps.query<ParticipantNodeRow>(
            `UPDATE "nodes"
             SET
               "name" = $1,
               "data" = $2,
               "source_type" = $3,
               "source_id" = $4,
               "updated_at" = NOW()
             WHERE "id" = $5
             RETURNING *`,
            [
              nodeName,
              nextData,
              sourceType,
              externalId,
              existingRow.id,
            ],
          );
          if (!updated.rows[0]) {
            throw new Error(`Failed to update participant: ${externalId}`);
          }
          return mapParticipantNode(updated.rows[0]);
        });
      },
    };
  },
});
