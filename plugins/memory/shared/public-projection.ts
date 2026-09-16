/** Shared public schemas and projections for Memory read Actions. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContextSourceRef } from "@copilotz/copilotz/core";
import type { MemoryRecordProjection } from "../authoring/consolidation/index.ts";
import { MEMORY_FORMS } from "../authoring/ontology/index.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const PUBLIC_MEMORY_SCAN_LIMIT = 1_000;
export const PUBLIC_MEMORY_RESULT_LIMIT = 100;
export const PUBLIC_MEMORY_SOURCE_LIMIT = 50;
export const PUBLIC_MEMORY_RELATION_LIMIT = 50;

const publicMemorySourceSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id"],
      properties: {
        type: { enum: ["message", "asset", "external"] },
        id: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "collection", "id"],
      properties: {
        type: { const: "collection_record" },
        collection: { type: "string" },
        id: { type: "string" },
        version: { type: ["string", "number"] },
        updatedAt: { type: "string" },
        fragment: { type: "string" },
      },
    },
  ],
} as const;

const publicMemorySourceListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "total", "returned", "truncated"],
  properties: {
    items: {
      type: "array",
      maxItems: PUBLIC_MEMORY_SOURCE_LIMIT,
      items: publicMemorySourceSchema,
    },
    total: {
      type: "integer",
      minimum: 0,
      description:
        "Total valid public sources present in this stored source set.",
    },
    returned: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
  },
} as const;

const publicMemoryNodeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: {
    type: { type: "string" },
    id: { type: "string" },
  },
} as const;

const publicMemoryTemporalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    validFrom: { type: "string" },
    validTo: { type: "string" },
    recordedAt: { type: "string" },
    invalidatedAt: { type: "string" },
  },
} as const;

const publicMemoryValiditySummarySchema = {
  enum: ["valid", "retracted", "superseded", "archived"],
} as const;

const publicMemoryValidityDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "sources"],
  properties: {
    status: publicMemoryValiditySummarySchema,
    changedAt: { type: "string" },
    reason: { type: "string" },
    replacementMemoryId: { type: "string" },
    sources: publicMemorySourceListSchema,
  },
} as const;

const publicMemorySummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "form",
    "kind",
    "summary",
    "status",
    "validity",
    "temporal",
    "similarity",
  ],
  properties: {
    id: { type: "string" },
    form: { enum: MEMORY_FORMS },
    kind: { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    validity: publicMemoryValiditySummarySchema,
    temporal: publicMemoryTemporalSchema,
    similarity: { type: "number" },
  },
} as const;

export const searchMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memories", "scanned", "matched", "returned", "truncated"],
  properties: {
    memories: {
      type: "array",
      maxItems: PUBLIC_MEMORY_RESULT_LIMIT,
      items: publicMemorySummarySchema,
    },
    scanned: {
      type: "integer",
      minimum: 0,
      description:
        "Accessible validly-shaped records examined in the bounded storage scan.",
    },
    matched: {
      type: "integer",
      minimum: 0,
      description:
        "Records matching the filters within the bounded scan; not a claimed global total.",
    },
    returned: { type: "integer", minimum: 0 },
    truncated: {
      type: "boolean",
      description:
        "True when the public result budget or the underlying bounded scan may have omitted records.",
    },
  },
} as const;

const publicMemoryDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "form",
    "kind",
    "summary",
    "status",
    "validity",
    "temporal",
    "provenance",
    "data",
  ],
  properties: {
    id: { type: "string" },
    form: { enum: MEMORY_FORMS },
    kind: { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    validity: publicMemoryValidityDetailSchema,
    temporal: publicMemoryTemporalSchema,
    epistemic: {
      type: "object",
      additionalProperties: false,
      required: ["basis", "stance"],
      properties: {
        basis: { enum: ["observed", "reported", "inferred", "assumed"] },
        stance: { enum: ["affirmed", "denied", "tentative", "disputed"] },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["sources"],
      properties: {
        sources: publicMemorySourceListSchema,
        assertedBy: publicMemoryNodeSchema,
        recordedBy: publicMemoryNodeSchema,
      },
    },
    data: { type: "object" },
  },
} as const;

export const inspectMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memory", "relations"],
  properties: {
    memory: publicMemoryDetailSchema,
    relations: {
      type: "object",
      additionalProperties: false,
      required: ["items", "scanned", "matched", "returned", "truncated"],
      properties: {
        items: {
          type: "array",
          maxItems: PUBLIC_MEMORY_RELATION_LIMIT,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "direction", "other"],
            properties: {
              type: { type: "string" },
              direction: { enum: ["incoming", "outgoing"] },
              other: publicMemoryNodeSchema,
            },
          },
        },
        scanned: {
          type: "integer",
          minimum: 0,
          description:
            "Graph relations examined in the bounded traversal before semantic and access filtering.",
        },
        matched: {
          type: "integer",
          minimum: 0,
          description:
            "Accessible relations matching the inspection; not a claimed global total.",
        },
        returned: { type: "integer", minimum: 0 },
        truncated: {
          type: "boolean",
          description:
            "True when the public relation budget or bounded traversal may have omitted relations.",
        },
      },
    },
  },
} as const;

function publicMemorySource(value: unknown): ContextSourceRef | null {
  const source = record(value);
  const type = optionalText(source.type);
  const id = optionalText(source.id);
  if (!type || !id) return null;
  if (type === "message" || type === "asset" || type === "external") {
    return ({ type, id } as const);
  }
  if (type !== "collection_record") return null;
  const collection = optionalText(source.collection);
  if (!collection) return null;
  const version = typeof source.version === "string" ||
      typeof source.version === "number"
    ? source.version
    : undefined;
  return ({
    type,
    collection,
    id,
    ...(version !== undefined ? { version } : {}),
    ...(optionalText(source.updatedAt)
      ? { updatedAt: optionalText(source.updatedAt)! }
      : {}),
    ...(optionalText(source.fragment)
      ? { fragment: optionalText(source.fragment)! }
      : {}),
  } as const);
}

function publicMemorySources(value: unknown) {
  const sources = (Array.isArray(value) ? value : []).flatMap((item) => {
    const source = publicMemorySource(item);
    return source ? [source] : [];
  });
  const items = sources.slice(0, PUBLIC_MEMORY_SOURCE_LIMIT);
  return ({
    items: items,
    total: sources.length,
    returned: items.length,
    truncated: items.length < sources.length,
  } as const);
}

function publicMemoryNode(value: unknown) {
  const node = record(value);
  const type = optionalText(node.type);
  const id = optionalText(node.id);
  return type && id ? ({ type, id } as const) : undefined;
}

function publicMemoryTemporal(value: unknown) {
  const temporal = record(value);
  return ({
    ...(optionalText(temporal.validFrom)
      ? { validFrom: optionalText(temporal.validFrom)! }
      : {}),
    ...(optionalText(temporal.validTo)
      ? { validTo: optionalText(temporal.validTo)! }
      : {}),
    ...(optionalText(temporal.recordedAt)
      ? { recordedAt: optionalText(temporal.recordedAt)! }
      : {}),
    ...(optionalText(temporal.invalidatedAt)
      ? { invalidatedAt: optionalText(temporal.invalidatedAt)! }
      : {}),
  } as const);
}

function publicMemoryEpistemic(value: unknown) {
  const epistemic = record(value);
  const basis = optionalText(epistemic.basis);
  const stance = optionalText(epistemic.stance);
  return basis && ["observed", "reported", "inferred", "assumed"].includes(
      basis,
    ) &&
      stance &&
      ["affirmed", "denied", "tentative", "disputed"].includes(stance)
    ? ({ basis, stance } as const)
    : undefined;
}

export function publicMemorySummary(
  item: CollectionRecord,
  mapped: MemoryRecordProjection,
  similarity: number,
) {
  return ({
    id: mapped.id,
    form: mapped.form,
    kind: mapped.kind,
    summary: mapped.summary,
    status: mapped.status,
    validity: mapped.validity,
    temporal: publicMemoryTemporal(item.temporal),
    similarity,
  } as const);
}

export function publicMemoryDetail(
  item: CollectionRecord,
  mapped: MemoryRecordProjection,
) {
  const validity = record(item.validity);
  const provenance = record(item.provenance);
  const assertedBy = publicMemoryNode(provenance.assertedBy);
  const recordedBy = publicMemoryNode(provenance.recordedBy);
  const epistemic = publicMemoryEpistemic(item.epistemic);
  return ({
    id: mapped.id,
    form: mapped.form,
    kind: mapped.kind,
    summary: mapped.summary,
    status: mapped.status,
    validity: {
      status: mapped.validity,
      ...(optionalText(validity.changedAt)
        ? { changedAt: optionalText(validity.changedAt)! }
        : {}),
      ...(optionalText(validity.reason)
        ? { reason: optionalText(validity.reason)! }
        : {}),
      ...(optionalText(validity.replacementMemoryId)
        ? { replacementMemoryId: optionalText(validity.replacementMemoryId)! }
        : {}),
      sources: publicMemorySources(validity.sources),
    } as const,
    temporal: publicMemoryTemporal(item.temporal),
    ...(epistemic ? { epistemic } : {}),
    provenance: {
      sources: publicMemorySources(provenance.sources),
      ...(assertedBy ? { assertedBy } : {}),
      ...(recordedBy ? { recordedBy } : {}),
    } as const,
    data: structuredClone(mapped.data),
  } as const);
}
