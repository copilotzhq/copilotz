/** Public note contracts; source pointers never grant access to source content. @module */
import type { StoredMemoryNote } from "./retrieval.ts";

export const PUBLIC_MEMORY_RESULT_LIMIT = 100;
const noteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text", "state", "lineage"],
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    state: { enum: ["active", "retired"] },
    lineage: {
      type: "object",
      additionalProperties: false,
      required: ["checkpointId", "createdAt"],
      properties: {
        checkpointId: { type: "string" },
        createdAt: { type: "string" },
      },
    },
    sources: { type: "array", items: { type: "object" } },
    sourcesWithheld: { const: true },
    retirement: { type: "object" },
    similarity: { type: "number" },
  },
} as const;

export const searchMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["notes", "returned", "truncated"],
  properties: {
    notes: {
      type: "array",
      maxItems: PUBLIC_MEMORY_RESULT_LIMIT,
      items: noteSchema,
    },
    returned: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
  },
} as const;

export const inspectMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["notes", "unavailableIds"],
  properties: {
    notes: {
      type: "array",
      maxItems: PUBLIC_MEMORY_RESULT_LIMIT,
      items: noteSchema,
    },
    unavailableIds: {
      type: "array",
      maxItems: PUBLIC_MEMORY_RESULT_LIMIT,
      items: { type: "string" },
    },
  },
} as const;

export function publicMemoryNote(
  note: StoredMemoryNote,
  detailed = false,
  revealSources = true,
) {
  return {
    id: note.id,
    text: note.text,
    state: note.retirement ? "retired" as const : "active" as const,
    lineage: { checkpointId: note.consolidationId, createdAt: note.createdAt },
    ...(detailed
      ? {
        ...(revealSources
          ? { sources: structuredClone(note.sources) }
          : { sourcesWithheld: true }),
        ...(note.retirement
          ? { retirement: structuredClone(note.retirement) }
          : {}),
      }
      : {}),
  };
}
