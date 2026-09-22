/** Defines the canonical Core Thread Collection. @module */

import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections/authoring";
import { metadataSchema, timestampsSchema } from "../../shared/schema.ts";
import { normalizeThreadMetadata } from "../../shared/thread-metadata.ts";

const PROTECTED_SYSTEM_NAMESPACES = new Set(["public", "system"]);
const PROTECTED_SYSTEM_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function requiredSystemNamespace(input: unknown): string {
  const namespace = typeof input === "string" ? input.trim() : "";
  if (
    !namespace || PROTECTED_SYSTEM_NAMESPACES.has(namespace) ||
    PROTECTED_SYSTEM_KEYS.has(namespace)
  ) {
    throw new TypeError("System metadata namespace is invalid.");
  }
  return namespace;
}

function systemMetadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

function validateSystemMetadataKeys(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PROTECTED_SYSTEM_KEYS.has(key)) {
      throw new TypeError(`${label} contains a protected key.`);
    }
  }
  return structuredClone(record);
}

function validateSystemMetadataUnset(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) {
    throw new TypeError("System metadata unset must be an array of keys.");
  }
  const keys = value.map((key) => key.trim());
  if (
    keys.some((key) => !key || PROTECTED_SYSTEM_KEYS.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw new TypeError("System metadata unset contains an invalid key.");
  }
  return keys;
}

export const threadCollection: CollectionDefinition = defineCollection({
  name: "thread",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      externalId: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
      spaceId: { type: "string", minLength: 1 },
      parentThreadId: { type: "string" },
      metadata: metadataSchema,
      participantIds: {
        type: "array",
        items: { type: "string" },
      },
      activeMessageBranch: {
        type: "object",
        additionalProperties: false,
        properties: {
          rootMessageId: { type: "string" },
          headMessageId: { type: "string" },
          previousRevisionMessageId: { type: "string" },
          revisionIndex: { type: "integer" },
        },
        required: [
          "rootMessageId",
          "headMessageId",
          "previousRevisionMessageId",
          "revisionIndex",
        ],
      },
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "status",
      "metadata",
      "participantIds",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    status: "active",
    metadata: {},
    participantIds: [],
  },
  identity: {
    sourceType: "thread_external_id",
    sourceField: "externalId",
  },
  search: { enabled: true, fields: ["name", "description"] },
  indexes: ["spaceId"],
  relations: {
    space: relation.belongsTo("space", "spaceId"),
    participants: relation.hasMany(
      "participant",
      "participantIds",
      "participates_in",
      "child-to-parent",
    ),
    parent: relation.belongsTo("thread", "parentThreadId", "has_child_thread"),
  },
  queries: {
    byExternalId: {
      filter({ input }) {
        return { externalId: String(input.externalId ?? "") };
      },
    },
  },
  commands: {
    addParticipant: {
      mutate({ current, input }) {
        const participantId = typeof (input as Record<string, unknown>)
            .participantId === "string"
          ? String((input as Record<string, unknown>).participantId).trim()
          : "";
        if (!participantId) {
          throw new TypeError("Participant ID must be non-empty.");
        }
        const currentIds = Array.isArray(current.participantIds)
          ? current.participantIds.filter((value): value is string =>
            typeof value === "string"
          )
          : [];
        if (currentIds.includes(participantId)) return undefined;
        return {
          set: {
            participantIds: [...new Set([...currentIds, participantId])],
          },
        };
      },
    },
    /** Atomically patches one plugin-owned namespace under metadata.system. */
    patchSystemMetadata: {
      event: "thread.system-metadata-patched",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace: { type: "string", minLength: 1 },
          set: { type: "object" },
          unset: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["namespace"],
      },
      mutate({ current, input }) {
        const data = input as Record<string, unknown>;
        const namespace = requiredSystemNamespace(data.namespace);
        const set = validateSystemMetadataKeys(data.set, "System metadata set");
        const unset = validateSystemMetadataUnset(data.unset);
        const metadata = normalizeThreadMetadata(current.metadata);
        const system = { ...metadata.system };
        const next = systemMetadataRecord(system[namespace]);
        for (const key of unset) delete next[key];
        Object.assign(next, set);
        if (Object.keys(next).length) system[namespace] = next;
        else delete system[namespace];
        return { set: { metadata: { ...metadata, system } } };
      },
    },
  },
});

export default threadCollection;
