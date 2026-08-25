import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineCollection } from "./definition.ts";

Deno.test("defineCollection snapshots and freezes named-query schemas", () => {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: { externalId: { type: "string" } },
    required: ["externalId"],
  } as const;
  const outputSchema = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  } as const;
  const definition = defineCollection({
    name: "query_schema_contract",
    schema: { type: "object", properties: {} },
    queries: {
      byExternalId: {
        inputSchema,
        outputSchema,
        filter: () => ({}),
      },
    },
  });
  const query = definition.queries?.byExternalId;

  assert(query);
  assert(Object.isFrozen(query.inputSchema));
  assert(Object.isFrozen(query.inputSchema?.properties));
  assert(Object.isFrozen(query.outputSchema));
  assert(Object.isFrozen(query.outputSchema?.items));

  (inputSchema as unknown as { required: string[] }).required[0] = "mutated";
  (outputSchema as unknown as { items: { required: string[] } }).items.required[
    0
  ] = "mutated";
  assertEquals(query.inputSchema?.required, ["externalId"]);
  assertEquals(
    (query.outputSchema?.items as { required?: readonly string[] }).required,
    ["id"],
  );
  assertThrows(() => {
    (query.inputSchema as { type: string }).type = "array";
  }, TypeError);
});

Deno.test("defineCollection rejects invalid named-query schemas", () => {
  assertThrows(
    () =>
      defineCollection({
        name: "invalid_query_schema",
        schema: { type: "object", properties: {} },
        queries: {
          all: { inputSchema: [] as never, filter: () => ({}) },
        },
      }),
    TypeError,
    "inputSchema must be a JSON Schema object",
  );
});
