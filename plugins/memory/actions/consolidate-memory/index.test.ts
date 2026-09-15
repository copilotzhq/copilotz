import { consolidationInputSchema } from "../../authoring/consolidation/schema.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Ajv } from "../../../../dependencies/ajv.ts";
import {
  CORE_MEMORY_KINDS,
  memorySourceKey,
} from "../../authoring/ontology/index.ts";
import { parseConsolidateMemoryInput } from "../../authoring/consolidation/index.ts";
import { consolidateMemoryTool } from "../../resources/tools/consolidate-memory/index.ts";
import { consolidateMemoryAction } from "./index.ts";
Deno.test("consolidate action publishes stable and auditable contracts", () => {
  const action = consolidateMemoryAction;
  assertEquals(action.id, "copilotz.memory.consolidation.commit");
  assertEquals(
    (action.inputSchema as { $defs?: unknown }).$defs !== undefined,
    true,
  );
  assertEquals(
    (action.outputSchema as { properties?: Record<string, unknown> })
      .properties?.createdRecords !== undefined,
    true,
  );
});

type SchemaObject = Record<string, unknown>;

function object(value: unknown): SchemaObject {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as SchemaObject;
}

function groupKindSchema(
  action: typeof consolidateMemoryAction,
  group: string,
) {
  const root = object(action.inputSchema);
  const properties = object(root.properties);
  const groupSchema = object(properties[group]);
  const items = object(groupSchema.items);
  return object(object(items.properties).kind);
}

Deno.test("consolidate schema publishes every registered kind with its semantics", () => {
  const action = {
    ...consolidateMemoryAction,
    inputSchema: consolidationInputSchema(CORE_MEMORY_KINDS),
  };
  const groups = {
    entity: "entities",
    assertion: "assertions",
    occurrence: "occurrences",
    intent: "intents",
    inquiry: "inquiries",
    procedure: "procedures",
  } as const;

  for (const [form, group] of Object.entries(groups)) {
    const kindSchema = groupKindSchema(action, group);
    const expected = CORE_MEMORY_KINDS.filter((kind) => kind.form === form);
    assertEquals(kindSchema.enum, expected.map((kind) => kind.id));
    const alternatives = kindSchema.oneOf as SchemaObject[];
    assertEquals(
      alternatives.map((item) => item.const),
      expected.map((kind) => kind.id),
    );
    for (const kind of expected) {
      const alternative = alternatives.find((item) => item.const === kind.id);
      assert(alternative);
      assertStringIncludes(String(alternative.description), kind.description);
    }
  }
});

Deno.test("consolidate schema is executable and matches required parser fields", () => {
  const action = consolidateMemoryAction;
  // deno-lint-ignore no-explicit-any
  const validate = new (Ajv as any)({ strict: false }).compile(
    action.inputSchema,
  );

  assert(validate({
    outcome: "changes",
    continuity: "The schema improvement remains active work.",
    intents: [{
      localId: "ship",
      kind: "intent.action",
      summary: "Ship the schema improvement.",
      status: "active",
    }],
  }));
  assertEquals(
    validate({ outcome: "changes", continuity: "No draft was provided." }),
    false,
  );
  assertEquals(
    validate({
      outcome: "no_changes",
      continuity: "The concealed mutation has no valid continuity.",
      entities: [{
        localId: "hidden",
        kind: "entity.project",
        summary: "A concealed mutation.",
        name: "Hidden",
      }],
    }),
    false,
  );
  assert(validate({
    outcome: "no_changes",
    continuity: "No durable memory changed in this turn.",
    entities: [],
  }));
  assertEquals(
    validate({
      outcome: "changes",
      continuity: "The relation needs valid evidence before it can persist.",
      relations: [{
        from: { memoryId: "memory-a" },
        type: "about",
        to: { memoryId: "memory-b" },
        sources: [],
      }],
    }),
    false,
  );
  assert(validate({
    outcome: "changes",
    continuity: "The enriched contract remains the active state.",
    lifecycle: [{
      target: {
        match: {
          form: "assertion",
          kind: "assertion.state",
          subject: { memoryId: "memory-a" },
          predicate: "memory_contract",
          query: "enriched contract",
        },
      },
      status: "superseded",
      sources: [{ type: "message", id: "message-a" }],
    }],
  }));
  assertEquals(
    validate({
      outcome: "changes",
      continuity: "The invalid kind must not change the active contract.",
      intents: [{
        localId: "ship",
        kind: "intent.not_registered",
        summary: "Invalid kind.",
        status: "active",
      }],
    }),
    true, // The Action validates kind registration from the final context.
  );
  assertEquals(
    validate({
      outcome: "changes",
      continuity: "The intent needs a valid lifecycle state.",
      intents: [{
        localId: "ship",
        kind: "intent.action",
        summary: "Missing required lifecycle status.",
      }],
    }),
    false,
  );
  assertEquals(
    validate({
      outcome: "changes",
      continuity: "The lifecycle transition needs a recognized status.",
      lifecycle: [{
        target: { memoryId: "memory-a" },
        status: "invented",
        sources: [{ type: "message", id: "message-a" }],
      }],
    }),
    false,
  );
});

Deno.test("registered kind data schemas are exposed as model-facing documentation", () => {
  const action = {
    ...consolidateMemoryAction,
    inputSchema: consolidationInputSchema([{
      id: "entity.repository",
      form: "entity",
      description: "A source-code repository.",
      schema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    }]),
  };
  const schema = groupKindSchema(action, "entities");
  assertEquals(schema.enum, ["entity.repository"]);
  const variant = object((schema.oneOf as unknown[])[0]);
  assertStringIncludes(
    String(variant.description),
    "A source-code repository.",
  );
  assertStringIncludes(String(variant.description), '"required":["name"]');
});

Deno.test("one complete corpus is accepted by both public schema and parser", () => {
  const action = consolidateMemoryAction;
  // deno-lint-ignore no-explicit-any
  const validate = new (Ajv as any)({ strict: false }).compile(
    action.inputSchema,
  );
  const source = { type: "message" as const, id: "message-a" };
  const corpus = {
    outcome: "changes",
    continuity:
      "The enriched static memory contract is active and needs validation.",
    entities: [{
      localId: "project",
      kind: "entity.project",
      summary: "Compass is the active project.",
      name: "Compass",
      aliases: ["Compass"],
      externalIds: { repository: "copilotzhq/compass" },
      sources: [source],
    }],
    assertions: [{
      localId: "state",
      kind: "assertion.state",
      summary: "Compass uses the enriched static memory contract.",
      subject: { localId: "project" },
      predicate: "memory_contract",
      object: { value: "enriched" },
      epistemic: { basis: "observed", stance: "affirmed" },
      temporal: { validFrom: "2026-08-31T00:00:00Z" },
      sources: [source],
    }],
    occurrences: [{
      localId: "release",
      kind: "occurrence.change",
      summary: "The static contract changed.",
      participants: [{ localId: "project" }],
      temporal: { startedAt: "2026-08-31T00:00:00Z" },
      sources: [source],
    }],
    intents: [{
      localId: "ship",
      kind: "intent.action",
      summary: "Ship the enriched static contract.",
      owner: { localId: "project" },
      target: { localId: "state" },
      status: "active",
      sources: [source],
    }],
    inquiries: [{
      localId: "question",
      kind: "inquiry.validation_needed",
      summary: "The published contract needs validation.",
      question: "Does schema match parser?",
      about: [{ localId: "state" }],
      answer: { localId: "release" },
      status: "answered",
      sources: [source],
    }],
    procedures: [{
      localId: "workflow",
      kind: "procedure.workflow",
      summary: "Validate static contracts against the parser.",
      trigger: "The public schema changes.",
      preconditions: ["The parser fixture is available."],
      steps: ["Compile the schema.", "Parse the same corpus."],
      expectedOutcome: "Both layers accept the corpus.",
      sources: [source],
    }],
    relations: [{
      from: { localId: "state" },
      type: "about",
      to: { localId: "project" },
      sources: [source],
    }],
    lifecycle: [{
      target: {
        match: {
          form: "assertion",
          kind: "assertion.state",
          subject: { localId: "project" },
          predicate: "memory_contract",
          query: "enriched static memory contract",
        },
      },
      status: "superseded",
      replacement: { localId: "state" },
      sources: [source],
    }],
  };

  assert(validate(corpus), JSON.stringify(validate.errors));
  const parsed = parseConsolidateMemoryInput(corpus, {
    kinds: new Map(CORE_MEMORY_KINDS.map((kind) => [kind.id, kind])),
    writableMemorySpaceIds: new Set(["space-a"]),
    defaultWriteMemorySpaceId: "space-a",
    allowedEvidenceSources: new Set([memorySourceKey(source)]),
    visibleMemoryIds: new Set(["memory-old"]),
    visibleNodeIds: new Set(),
  });
  assertEquals(parsed.entities?.length, 1);
  assertEquals(parsed.assertions?.length, 1);
  assertEquals(parsed.occurrences?.length, 1);
  assertEquals(parsed.intents?.length, 1);
  assertEquals(parsed.inquiries?.length, 1);
  assertEquals(parsed.procedures?.length, 1);
  assertEquals(parsed.relations?.length, 1);
  assertEquals(parsed.lifecycle?.length, 1);
});

Deno.test("consolidate output schema publishes the runtime audit bounds", () => {
  const action = consolidateMemoryAction;
  const properties = object(object(action.outputSchema).properties);
  for (
    const name of [
      "createdRecords",
      "reusedRecords",
      "unresolvedReconciliations",
    ]
  ) {
    assertEquals(object(properties[name]).maxItems, 100);
  }
  assertEquals(object(action.inputSchema).example, {
    outcome: "no_changes",
    continuity:
      "Continue the current release: verify the memory output contract, then publish after the checks pass. The current constraint is preserving certified history coverage; no durable memory records changed. No user question is pending.",
  });
  assertEquals(
    object(object(object(action.inputSchema).properties).outcome).example,
    "no_changes",
  );
  assertStringIncludes(String(object(properties.created).description), "Total");
  assertStringIncludes(
    String(object(properties.unresolved).description),
    "Total",
  );
  const validateOutput = new (Ajv as any)({ strict: false }).compile(
    action.outputSchema,
  );
  assert(
    validateOutput({
      outcome: "no_changes",
      continuity: "Continue validation; no durable record changed.",
      created: 0,
      reused: 0,
      lifecycleChanged: 0,
      createdRecords: [],
      reusedRecords: [],
      unresolvedReconciliations: [],
    }),
    JSON.stringify(validateOutput.errors),
  );
  assertEquals(
    validateOutput({ outcome: "no_changes", continuity: "" }),
    false,
  );
});

Deno.test("consolidate Tool preserves the enriched Action schema losslessly", () => {
  const action = consolidateMemoryAction;
  const tool = consolidateMemoryTool;

  assertEquals(tool.inputSchema, action.inputSchema);
  assert(tool.inputSchema !== action.inputSchema);
  const kindSchema = groupKindSchema(
    { ...action, inputSchema: tool.inputSchema },
    "assertions",
  );
  assertEquals(kindSchema.type, "string");
  assertEquals(kindSchema.enum, undefined);
  assertStringIncludes(
    String(kindSchema.description),
    "final context",
  );
  assertStringIncludes(tool.description, "never invent evidence IDs");
});
