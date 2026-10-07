/** Immutable note text with append-only source and retirement audit. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { MemoryProposalConflict } from "../../authoring/notes/index.ts";

const source = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id"],
      properties: {
        type: { enum: ["message", "asset", "external"] },
        id: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "collection", "id"],
      properties: {
        type: { const: "collection_record" },
        collection: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
        version: { type: ["string", "number"] },
        updatedAt: { type: "string" },
        fragment: { type: "string" },
      },
    },
  ],
} as const;

const retirement = {
  type: "object",
  additionalProperties: false,
  required: ["checkpointId", "retiredAt", "retiredBy", "reason"],
  properties: {
    checkpointId: { type: "string", minLength: 1 },
    retiredAt: { type: "string", minLength: 1 },
    retiredBy: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    replacedBy: { type: "string", minLength: 1 },
  },
} as const;

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "text",
    "memorySpaceId",
    "consolidationId",
    "createdByAgentId",
    "originThreadId",
    "sources",
    "retirement",
  ],
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    text: { type: "string", minLength: 1 },
    memorySpaceId: { type: "string", minLength: 1 },
    consolidationId: { type: "string", minLength: 1 },
    createdByAgentId: { type: "string", minLength: 1 },
    originThreadId: { type: "string", minLength: 1 },
    sources: { type: "array", items: source, uniqueItems: true },
    retirement: { anyOf: [retirement, { type: "null" }] },
  },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
        [key, entry],
      ) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export const memoryNoteCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: "memory_note",
    schema,
    indexes: [["memorySpaceId", "createdAt"], "consolidationId"],
    search: { enabled: true, fields: ["text"] },
    relations: {
      memorySpace: relation.belongsTo(
        "memory_space",
        "memorySpaceId",
        "has_memory_note",
      ),
      checkpoint: relation.belongsTo(
        "long_term_memory",
        "consolidationId",
        "includes_memory_note",
      ),
    },
    beforeUpdate(next, { current }) {
      if (!current) {
        throw new Error("Memory note update requires its existing record.");
      }
      for (
        const field of [
          "id",
          "namespace",
          "text",
          "memorySpaceId",
          "consolidationId",
          "createdByAgentId",
          "originThreadId",
          "createdAt",
        ]
      ) {
        if (canonical(next[field]) !== canonical(current[field])) {
          throw new TypeError(
            `Memory note '${field}' is immutable; write a replacement note.`,
          );
        }
      }
      const sources = new Set((next.sources as unknown[]).map(canonical));
      if (
        (current.sources as unknown[]).some((item) =>
          !sources.has(canonical(item))
        )
      ) throw new TypeError("Memory note sources are append-only.");
      if (
        current.retirement &&
        canonical(current.retirement) !== canonical(next.retirement)
      ) throw new TypeError("A memory note retirement is permanent.");
      return next;
    },
    commands: {
      retire: {
        input: {
          type: "object",
          additionalProperties: false,
          required: ["memorySpaceId", "retirement"],
          properties: {
            memorySpaceId: { type: "string" },
            retirement,
          },
        },
        mutate({ current, input }) {
          const requested = input as {
            memorySpaceId: string;
            retirement: unknown;
          };
          if (
            current.memorySpaceId !== requested.memorySpaceId ||
            current.retirement
          ) {
            throw new MemoryProposalConflict(
              `Note '${current.id}' is no longer active in the writable scope.`,
              [String(current.id)],
            );
          }
          return { set: { retirement: requested.retirement } };
        },
      },
      addSources: {
        input: {
          type: "object",
          additionalProperties: false,
          required: [
            "memorySpaceId",
            "sources",
            "originThreadId",
            "createdByAgentId",
          ],
          properties: {
            memorySpaceId: { type: "string" },
            originThreadId: { type: "string" },
            createdByAgentId: { type: "string" },
            sources: { type: "array", items: source },
          },
        },
        mutate({ current, input }) {
          const requested = input as {
            memorySpaceId: string;
            originThreadId: string;
            createdByAgentId: string;
            sources: unknown[];
          };
          if (
            current.memorySpaceId !== requested.memorySpaceId ||
            current.retirement
          ) {
            throw new MemoryProposalConflict(
              `Note '${current.id}' is no longer active in the writable scope.`,
              [String(current.id)],
            );
          }
          // Reusing shared text must not expose another author's source IDs
          // through the original author's inspect permission.
          if (
            current.originThreadId !== requested.originThreadId ||
            current.createdByAgentId !== requested.createdByAgentId
          ) {
            return { set: {} };
          }
          return {
            set: {
              sources: [
                ...new Map(
                  [...(current.sources as unknown[]), ...requested.sources].map(
                    (value) => [canonical(value), value],
                  ),
                ).values(),
              ],
            },
          };
        },
      },
    },
  });

export default memoryNoteCollection;
