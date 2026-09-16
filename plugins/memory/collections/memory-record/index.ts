/** Semantic-memory record collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { MEMORY_EDGE } from "../../shared/relations.ts";

/** Compares JSON-safe values independent of object-key serialization order. */
/** Compares JSON-safe values independently of object-key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right)
      ).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    memorySpaceId: { type: "string" },
    consolidationId: { type: "string" },
    createdByAgentId: { type: "string" },
    originThreadId: { type: "string" },
    form: {
      type: "string",
      enum: [
        "entity",
        "assertion",
        "occurrence",
        "intent",
        "inquiry",
        "procedure",
      ],
    },
    status: {
      type: "string",
      enum: [
        "active",
        "merged",
        "archived",
        "current",
        "superseded",
        "retracted",
        "disputed",
        "scheduled",
        "happened",
        "cancelled",
        "proposed",
        "completed",
        "open",
        "answered",
        "obsolete",
        "deprecated",
      ],
    },
    kind: { type: "string" },
    summary: { type: "string" },
    validity: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["valid", "retracted", "superseded", "archived"],
        },
        changedAt: { type: "string" },
        reason: { type: "string" },
        sources: { type: "array", items: { type: "object" } },
        replacementMemoryId: { type: "string" },
      },
    },
    content: { type: "array" },
    temporal: { type: "object" },
    epistemic: { type: ["object", "null"] },
    provenance: { type: "object" },
    data: { type: "object" },
    metadata: { type: ["object", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "memorySpaceId",
    "consolidationId",
    "createdByAgentId",
    "originThreadId",
    "form",
    "status",
    "validity",
    "kind",
    "summary",
    "temporal",
    "provenance",
    "data",
  ],
} as const;

export const memoryRecordCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: "memory_record",
    schema: schema,
    indexes: [
      "memorySpaceId",
      "consolidationId",
      "createdByAgentId",
      "originThreadId",
      ["memorySpaceId", "createdByAgentId"],
      ["form", "kind"],
      "status",
      "kind",
    ],
    relations: {
      memorySpace: relation.belongsTo(
        "memory_space",
        "memorySpaceId",
        MEMORY_EDGE.hasRecord,
      ),
      checkpoint: relation.belongsTo(
        "long_term_memory",
        "consolidationId",
        MEMORY_EDGE.includesRecord,
      ),
    },
    search: { enabled: true, fields: ["summary"] },
    content: { fields: ["content"] },
    commands: {
      invalidate: {
        mutate({ current, input }) {
          const patch =
            input && typeof input === "object" && !Array.isArray(input)
              ? input as Record<string, unknown>
              : {};
          const next = patch.validity && typeof patch.validity === "object" &&
              !Array.isArray(patch.validity)
            ? patch.validity as Record<string, unknown>
            : null;
          if (
            !next ||
            !["retracted", "superseded", "archived"].includes(
              String(next.status),
            )
          ) {
            throw new TypeError(
              "Memory invalidation requires a valid editorial disposition.",
            );
          }
          const previous =
            current.validity && typeof current.validity === "object" &&
              !Array.isArray(current.validity)
              ? current.validity as Record<string, unknown>
              : {};
          if (previous.status === "valid") return { set: { validity: next } };
          const same = previous.status === next.status &&
            previous.reason === next.reason &&
            previous.replacementMemoryId === next.replacementMemoryId &&
            canonicalJson(previous.sources ?? []) ===
              canonicalJson(next.sources ?? []);
          if (same) return { set: {} };
          throw new Error(
            `Memory '${current.id}' already has a different editorial disposition.`,
          );
        },
      },
    },
  });

export default memoryRecordCollection;
