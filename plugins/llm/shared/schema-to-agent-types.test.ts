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
