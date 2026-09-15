/** Shared model-facing proposal schema and structural validation. @module */
import type { ActionSchema } from "@copilotz/copilotz/actions";
import { Ajv } from "../../../../dependencies/ajv.ts";
import {
  MEMORY_FORMS,
  type MemoryForm,
  type MemoryKindDefinition,
} from "../ontology/index.ts";

const commonDraft: Readonly<Record<string, ActionSchema>> = {
  localId: {
    type: "string",
    minLength: 1,
    description:
      "Unique temporary ID within this payload. Use { localId } references to connect drafts before canonical memory IDs exist.",
  },
  summary: {
    type: "string",
    minLength: 1,
    description:
      "Self-contained durable summary used for retrieval. Preserve uncertainty, negation, ownership, and temporal meaning.",
  },
  spaceId: {
    type: "string",
    description:
      "Optional writable memory-space ID. Omit it to use the checkpoint's trusted default writable space.",
  },
  attributes: {
    type: "object",
    description:
      "Optional namespaced semantic attributes. When the selected kind documents an additional persisted-data schema, the final semantic data (including these attributes) must satisfy it.",
  },
  sources: {
    type: "array",
    items: { $ref: "#/$defs/source" },
    minItems: 1,
    description:
      "Optional explicit evidence. IDs must be authorized for this checkpoint. If omitted, the runtime currently uses the checkpoint's trusted default evidence; use explicit sources only when canonical IDs are actually available.",
  },
};
const forms: Readonly<
  Record<
    MemoryForm,
    {
      group: string;
      required: readonly string[];
      properties: Readonly<Record<string, ActionSchema>>;
    }
  >
> = {
  entity: {
    group: "entities",
    required: ["localId", "kind", "summary", "name"],
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "Canonical display name of the entity.",
      },
      aliases: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      externalIds: {
        type: "object",
        additionalProperties: { type: "string", minLength: 1 },
      },
    },
  },
  assertion: {
    group: "assertions",
    required: [
      "localId",
      "kind",
      "summary",
      "subject",
      "predicate",
      "object",
      "epistemic",
    ],
    properties: {
      subject: { $ref: "#/$defs/ref" },
      predicate: {
        type: "string",
        minLength: 1,
        description: "Stable domain predicate relating subject and object.",
      },
      object: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["ref"],
            properties: { ref: { $ref: "#/$defs/ref" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["value"],
            properties: {
              value: { type: ["string", "number", "boolean", "null"] },
            },
          },
        ],
      },
      epistemic: {
        type: "object",
        additionalProperties: false,
        required: ["basis", "stance"],
        properties: {
          basis: { enum: ["observed", "reported", "inferred", "assumed"] },
          stance: { enum: ["affirmed", "denied", "tentative", "disputed"] },
        },
      },
      temporal: {
        type: "object",
        additionalProperties: false,
        properties: {
          validFrom: { type: "string" },
          validTo: { type: "string" },
        },
      },
    },
  },
  occurrence: {
    group: "occurrences",
    required: ["localId", "kind", "summary"],
    properties: {
      participants: { type: "array", items: { $ref: "#/$defs/ref" } },
      temporal: {
        type: "object",
        additionalProperties: false,
        properties: {
          startedAt: { type: "string" },
          endedAt: { type: "string" },
        },
      },
    },
  },
  intent: {
    group: "intents",
    required: ["localId", "kind", "summary", "status"],
    properties: {
      owner: { $ref: "#/$defs/ref" },
      target: { $ref: "#/$defs/ref" },
      status: { enum: ["proposed", "active", "completed", "cancelled"] },
      dueAt: { type: "string" },
    },
  },
  inquiry: {
    group: "inquiries",
    required: ["localId", "kind", "summary", "question", "status"],
    properties: {
      question: {
        type: "string",
        minLength: 1,
        description: "The unresolved or answered question in explicit form.",
      },
      about: { type: "array", items: { $ref: "#/$defs/ref" } },
      answer: { $ref: "#/$defs/ref" },
      status: { enum: ["open", "answered", "obsolete"] },
    },
  },
  procedure: {
    group: "procedures",
    required: ["localId", "kind", "summary", "steps"],
    properties: {
      trigger: { type: "string" },
      preconditions: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      steps: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
        description: "Ordered, non-empty reusable procedure steps.",
      },
      expectedOutcome: { type: "string" },
      applicability: { type: "string" },
    },
  },
};
const root: ActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "continuity"],
  example: {
    outcome: "no_changes",
    continuity:
      "Continue the current release: verify the memory output contract, then publish after the checks pass. The current constraint is preserving certified history coverage; no durable memory records changed. No user question is pending.",
  },
  $defs: {
    source: {
      description:
        "Trusted evidence reference. Explicit references must use canonical IDs authorized for the current checkpoint; do not invent IDs. Omit draft sources when no authorized ID is available.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "id"],
          properties: {
            type: { enum: ["message", "asset", "external"] },
            id: {
              type: "string",
              minLength: 1,
              description:
                "Canonical source ID supplied by trusted context or a discovery Tool.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "collection", "id"],
          properties: {
            type: { const: "collection_record" },
            collection: { type: "string", minLength: 1 },
            id: {
              type: "string",
              minLength: 1,
              description:
                "Canonical record ID supplied by the frozen trusted context.",
            },
            version: { type: ["string", "number"] },
            updatedAt: { type: "string" },
            fragment: { type: "string" },
          },
        },
      ],
    },
    ref: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["localId"],
          properties: {
            localId: {
              type: "string",
              minLength: 1,
              example: "project",
              description:
                "Temporary ID defined by another draft in this same payload.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["memoryId"],
          properties: { memoryId: { type: "string", minLength: 1 } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["node"],
          properties: {
            node: {
              type: "object",
              additionalProperties: false,
              required: ["type", "id"],
              description:
                "Domain node visible in the frozen checkpoint context. Both type and canonical ID must come from trusted context.",
              properties: {
                type: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
              },
            },
          },
        },
      ],
    },
  },
  oneOf: [
    {
      properties: { outcome: { const: "changes" } },
      anyOf: [
        { required: ["entities"], properties: { entities: { minItems: 1 } } },
        {
          required: ["assertions"],
          properties: { assertions: { minItems: 1 } },
        },
        {
          required: ["occurrences"],
          properties: { occurrences: { minItems: 1 } },
        },
        { required: ["intents"], properties: { intents: { minItems: 1 } } },
        { required: ["inquiries"], properties: { inquiries: { minItems: 1 } } },
        {
          required: ["procedures"],
          properties: { procedures: { minItems: 1 } },
        },
        { required: ["relations"], properties: { relations: { minItems: 1 } } },
        { required: ["lifecycle"], properties: { lifecycle: { minItems: 1 } } },
      ],
    },
    {
      properties: { outcome: { const: "no_changes" } },
      allOf: [
        { properties: { entities: { maxItems: 0 } } },
        { properties: { assertions: { maxItems: 0 } } },
        { properties: { occurrences: { maxItems: 0 } } },
        { properties: { intents: { maxItems: 0 } } },
        { properties: { inquiries: { maxItems: 0 } } },
        { properties: { procedures: { maxItems: 0 } } },
        { properties: { relations: { maxItems: 0 } } },
        { properties: { lifecycle: { maxItems: 0 } } },
      ],
    },
  ],
};
const properties: Readonly<Record<string, ActionSchema>> = {
  outcome: {
    enum: ["changes", "no_changes"],
    example: "no_changes",
    description:
      "Use changes when at least one draft, relation, or lifecycle change is present. Use no_changes when no durable memory record should be written; continuity is still required.",
  },
  continuity: {
    type: "string",
    minLength: 1,
    description:
      "Required in every payload, including no_changes. This replaces the compacted conversation prefix, whose source messages will no longer be directly present in the next prompt. State the active task, constraints, decisions/results, outstanding work, and uncertainty so work can continue without those messages.",
  },
  relations: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["from", "type", "to"],
      properties: {
        from: { $ref: "#/$defs/ref" },
        type: {
          enum: [
            "about",
            "same_as",
            "supports",
            "contradicts",
            "depends_on",
            "contributes_to",
            "blocks",
            "answers",
          ],
        },
        to: { $ref: "#/$defs/ref" },
        sources: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/source" },
          description:
            "Optional explicit relation evidence. When present it must contain at least one authorized canonical source.",
        },
      },
    },
  },
  lifecycle: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["target", "status", "sources"],
      properties: {
        target: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["memoryId"],
              properties: { memoryId: { type: "string" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["match"],
              properties: {
                match: {
                  type: "object",
                  additionalProperties: false,
                  required: ["form", "query"],
                  properties: {
                    form: {
                      enum: [
                        "entity",
                        "assertion",
                        "occurrence",
                        "intent",
                        "inquiry",
                        "procedure",
                      ],
                    },
                    kind: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Optional kind used to narrow visible candidates. Use a registered kind for the selected form; resolution remains state-dependent.",
                    },
                    subject: {
                      $ref: "#/$defs/ref",
                      description:
                        "Optional subject filter accepted by the parser. Any memoryId or node reference must come from visible trusted context.",
                    },
                    predicate: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Optional stable predicate used to narrow lifecycle candidates.",
                    },
                    query: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Lexical query that must resolve exactly one visible memory; zero or multiple matches are returned as unresolved.",
                    },
                  },
                },
              },
            },
          ],
        },
        status: {
          enum: [
            "superseded",
            "retracted",
            "completed",
            "cancelled",
            "answered",
            "obsolete",
            "deprecated",
          ],
          description:
            "Lifecycle transition of the described object. Use invalidate_memory, not lifecycle, for editorial invalidation of the memory record.",
        },
        replacement: { $ref: "#/$defs/ref" },
        sources: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/source" },
        },
      },
    },
  },
};

export function consolidationInputSchema(
  kinds: readonly MemoryKindDefinition[] = [],
): ActionSchema {
  const drafts: Record<string, ActionSchema> = {};
  for (const form of MEMORY_FORMS) {
    const definition = forms[form];
    const registered = kinds.filter((kind) => kind.form === form);
    drafts[definition.group] = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: definition.required,
        properties: {
          ...commonDraft,
          ...definition.properties,
          localId: { ...commonDraft.localId, example: `${form}-1` },
          kind: registered.length
            ? {
              type: "string",
              enum: registered.map((kind) => kind.id),
              description:
                `Registered ${form} kind. Choose by semantics; arbitrary strings are rejected. ${
                  registered.map((kind) =>
                    `${kind.id} — ${kind.description}${
                      kind.schema
                        ? ` Persisted semantic data schema: ${
                          JSON.stringify(kind.schema)
                        }`
                        : " No additional kind-specific data schema is registered."
                    }`
                  ).join(" ")
                }`,
              oneOf: registered.map((kind) => ({
                const: kind.id,
                title: kind.id,
                description: kind.schema
                  ? `${kind.description} Persisted semantic data must also satisfy: ${
                    JSON.stringify(kind.schema)
                  }`
                  : `${kind.description} No additional kind-specific fields are registered.`,
              })),
            }
            : {
              type: "string",
              minLength: 1,
              description:
                `Registered ${form} kind from resources.memory.kinds; the Action validates it against the final context.`,
            },
        },
      },
    };
  }
  return structuredClone({ ...root, properties: { ...properties, ...drafts } });
}

type Validator = ((value: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};
// Ajv's CJS constructor is untyped at this portable dependency boundary.
// deno-lint-ignore no-explicit-any
const ajv = new (Ajv as any)({
  strict: false,
  allErrors: true,
  useDefaults: false,
});
const validators = new Map<
  string,
  { schema: ActionSchema; validate: Validator }
>();

export function assertConsolidationInput(
  value: unknown,
  kinds: readonly MemoryKindDefinition[],
): void {
  const key = JSON.stringify(kinds);
  let cached = validators.get(key);
  if (!cached) {
    const schema = consolidationInputSchema(kinds);
    cached = { schema, validate: ajv.compile(schema) as Validator };
    // Applications may supply dynamic catalogues; bound both caches.
    if (validators.size >= 16) {
      const oldest = validators.keys().next().value!;
      ajv.removeSchema(validators.get(oldest)!.schema);
      validators.delete(oldest);
    }
    validators.set(key, cached);
  }
  if (!cached.validate(value)) {
    const input = value && typeof value === "object"
      ? value as Record<string, unknown>
      : {};
    const changed = [
      ...Object.values(forms).map((form) => form.group),
      "relations",
      "lifecycle",
    ]
      .some((group) => Array.isArray(input[group]) && input[group].length > 0);
    if (input.outcome === "no_changes" && changed) {
      throw new TypeError("A no_changes consolidation cannot contain changes.");
    }
    if (input.outcome === "changes" && !changed) {
      throw new TypeError(
        "A changes consolidation must contain at least one change.",
      );
    }
    throw new TypeError(
      `Invalid consolidate_memory input: ${
        ajv.errorsText(cached.validate.errors)
      }`,
    );
  }
}
