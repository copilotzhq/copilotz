import { assert, assertEquals } from "@std/assert";
import { generateAgentTypesFromSchema } from "./schema-to-agent-types.ts";

Deno.test("schema renderer emits nested TypeScript interfaces", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      schedule: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Cron expression." },
          timezone: { type: "string" },
        },
        required: ["expression"],
      },
      recipients: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["schedule"],
  }, { rootName: "JobsInput", moduleName: "Jobs" });

  assert(output.includes("export interface JobsInput {"));
  assert(output.includes("export interface Schedule {"));
  assert(output.includes("expression: string;"));
  assert(output.includes("timezone?: string;"));
  assert(output.includes("recipients?: string[];"));
  assert(!output.includes('"type": "object"'));
});

Deno.test("schema renderer emits root action unions with branch requirements", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "get", "create"] },
      id: { type: "string" },
      name: { type: "string" },
    },
    required: ["action"],
    oneOf: [
      {
        properties: { action: { const: "list" } },
        required: ["action"],
      },
      {
        properties: { action: { const: "get" } },
        required: ["action", "id"],
      },
      {
        properties: { action: { const: "create" } },
        required: ["action", "name"],
      },
    ],
  }, { rootName: "JobsInput", moduleName: "Jobs" });

  assert(output.includes("export type JobsInput ="));
  assert(output.includes('action: "list";'));
  assert(output.includes('action: "get";'));
  assert(output.includes("id: string;"));
  assert(output.includes('action: "create";'));
  assert(output.includes("name: string;"));
  assertEquals(output.includes("inputSchema"), false);
  assertEquals(output.includes('"oneOf"'), false);
});

Deno.test("schema renderer resolves refs and allOf fields", () => {
  const output = generateAgentTypesFromSchema({
    $defs: {
      identity: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    allOf: [
      { type: "object", properties: { name: { type: "string" } } },
      {
        type: "object",
        properties: { identity: { $ref: "#/$defs/identity" } },
        required: ["identity"],
      },
    ],
  }, { rootName: "RecordInput", moduleName: "Record" });

  assert(output.includes("name?: string;"));
  assert(output.includes("identity: Identity;"));
  assert(output.includes("export interface Identity {"));
  assert(output.includes("id: string;"));
});

Deno.test("schema renderer emits shared and recursive source definitions once", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    $defs: {
      Source: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          parent: { $ref: "#/$defs/Source" },
        },
        required: ["id"],
      },
    },
    properties: {
      source: { $ref: "#/$defs/Source" },
      sources: { type: "array", items: { $ref: "#/$defs/Source" } },
    },
  });
  assertEquals((output.match(/export interface Source \{/g) ?? []).length, 1);
  assert(output.includes("source?: Source;"));
  assert(output.includes("sources?: Source[];"));
  assert(output.includes("parent?: Source;"));
  assert(output.includes("id: string;"));
  assert(!output.includes("Circular reference"));
});

Deno.test("schema renderer respects open maps, descriptions and constraints", () => {
  const description =
    "A full description with meaningful restrictions. ".repeat(6) +
    "Never replace an immutable ID.";
  const output = generateAgentTypesFromSchema({
    type: "object",
    properties: {
      attributes: { type: "object" },
      empty: { type: "object", additionalProperties: false },
      text: { type: "string", description, minLength: 2, maxLength: 200 },
      count: { type: "integer", minimum: 1, maximum: 5 },
    },
  });
  assert(output.includes("attributes?: Record<string, unknown>;"));
  assert(output.includes("empty?: Record<string, never>;"));
  assert(output.includes(description));
  assert(output.includes("minLen 2, maxLen 200"));
  assert(output.includes("1..5"));
  assert(!output.includes("Optional."));
});

Deno.test("schema renderer preserves structural siblings of a reference", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    $defs: {
      Identity: { type: "object", properties: { id: { type: "string" } } },
    },
    properties: {
      owner: {
        $ref: "#/$defs/Identity",
        type: "object",
        properties: { role: { const: "owner" } },
        required: ["role"],
      },
    },
  });
  assert(output.includes("Identity & OwnerConstraint"));
  assert(output.includes('role: "owner";'));
});

Deno.test("schema renderer keeps colliding inline and shared names distinct", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    properties: {
      item: { type: "object", properties: { inline: { type: "boolean" } } },
      ref: { $ref: "#/$defs/Item" },
      nested: { $ref: "#" },
    },
    $defs: {
      Item: { type: "object", properties: { shared: { type: "string" } } },
    },
  });
  assert(output.includes("item?: Item;"));
  assert(output.includes("ref?: Item2;"));
  assert(output.includes("inline?: boolean;"));
  assert(output.includes("shared?: string;"));
  assert(output.includes("nested?: ToolInput;"));
  assertEquals(
    (output.match(/export interface ToolInput \{/g) ?? []).length,
    1,
  );
  assert(
    generateAgentTypesFromSchema({ type: "string" }).includes(
      "export type ToolInput = string;",
    ),
  );
});
