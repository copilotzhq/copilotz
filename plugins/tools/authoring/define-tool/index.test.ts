import { assert, assertEquals, assertThrows } from "@std/assert";
import { type ActionSchema, defineAction } from "@copilotz/copilotz/actions";
import { defineTool, type ToolResource } from "./index.ts";
import { createToolsPlugin } from "../tools-plugin/index.ts";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { query: { type: "string" } },
  required: ["query"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { result: { type: "string" } },
  required: ["result"],
} as const;

const searchAction = defineAction({
  id: "search.query",
  inputSchema,
  outputSchema,
  execute(input: Readonly<{ query: string }>) {
    return { result: input.query };
  },
});

Deno.test("ToolResource is an ordinary data-only Action presentation", () => {
  const plain = {
    action: "search",
    name: "Search",
    description: "Search indexed documents.",
    inputSchema,
    outputSchema,
    history: { visibility: "requester_only" },
    metadata: { category: "retrieval" },
  } as const satisfies ToolResource<"search">;

  function acceptsTool(resource: ToolResource): ToolResource {
    return resource;
  }

  assertEquals(acceptsTool(plain), plain);
  assertEquals(Object.keys(plain), [
    "action",
    "name",
    "description",
    "inputSchema",
    "outputSchema",
    "history",
    "metadata",
  ]);
  type HasExecute = "execute" extends keyof ToolResource ? true : false;
  type HasId = "id" extends keyof ToolResource ? true : false;
  type HasKey = "key" extends keyof ToolResource ? true : false;
  type HasContext = "context" extends keyof ToolResource ? true : false;
  const forbidden: [HasExecute, HasId, HasKey, HasContext] = [
    false,
    false,
    false,
    false,
  ];
  assertEquals(forbidden, [false, false, false, false]);
});

Deno.test("defineTool preserves its alias and snapshots optional Action schemas", () => {
  const tool = defineTool("search", searchAction, {
    name: "Search",
    description: "Search indexed documents.",
    history: { visibility: "public_status" },
    metadata: { category: "retrieval" },
  });

  const inferredAlias: "search" = tool.action;
  const inferredName: "Search" = tool.name;
  const inferredInputSchema: typeof inputSchema | undefined = tool.inputSchema;
  const inferredOutputSchema: typeof outputSchema | undefined =
    tool.outputSchema;
  assertEquals(inferredAlias, "search");
  assertEquals(inferredName, "Search");
  assertEquals(inferredInputSchema, inputSchema);
  assertEquals(inferredOutputSchema, outputSchema);
  assert(tool.inputSchema !== searchAction.inputSchema);
  assert(tool.outputSchema !== searchAction.outputSchema);
  assertEquals(Object.keys(tool), [
    "action",
    "name",
    "description",
    "inputSchema",
    "outputSchema",
    "history",
    "metadata",
  ]);
  assert(Object.isFrozen(tool));
  assert(Object.isFrozen(tool.inputSchema));
  assert(Object.isFrozen(tool.inputSchema?.properties));
  assert(Object.isFrozen(tool.outputSchema));
  assert(Object.isFrozen(tool.outputSchema?.properties));
  assert(Object.isFrozen(tool.history));
  assert(Object.isFrozen(tool.metadata));
});

Deno.test("object-form defineTool infers an Action and createToolsPlugin keeps Resources data-only", async () => {
  const lookup = defineTool({
    id: "tool.lookup",
    name: "Lookup",
    description: "Looks up one value.",
    inputSchema,
    outputSchema,
    history: { visibility: "public" },
    metadata: { category: "example" },
    execute(input: Readonly<{ query: string }>) {
      return { result: input.query.toUpperCase() };
    },
  });
  const plugin = createToolsPlugin({ tools: { lookup } });
  const action = plugin.actions.lookup;
  const tool = plugin.resources.tools.lookup as ToolResource<"lookup">;

  assertEquals(lookup.action.id, "tool.lookup");
  assertEquals(await action.execute({ query: "copilotz" }, {} as never), {
    result: "COPILOTZ",
  });
  assertEquals(tool, {
    action: "lookup",
    name: "Lookup",
    description: "Looks up one value.",
    inputSchema,
    outputSchema,
    history: { visibility: "public" },
    metadata: { category: "example" },
  });
  assertEquals("execute" in tool, false);
  assertEquals(Object.keys(plugin.actions), ["lookup"]);
  assertEquals(Object.keys(plugin.resources.tools), ["lookup"]);
});

Deno.test("defineTool isolates schema and metadata mutations deeply", () => {
  const mutableInput = {
    type: "object",
    properties: { query: { type: "string" } },
  };
  const mutableOutput = {
    type: "object",
    properties: { answer: { type: "string" } },
  };
  const mutableMetadata = { provider: { id: "original" } };
  const action = defineAction({
    id: "search.mutable",
    inputSchema: mutableInput as ActionSchema,
    outputSchema: mutableOutput as ActionSchema,
    execute() {
      return { answer: "ok" };
    },
  });
  const tool = defineTool("mutableSearch", action, {
    name: "Mutable search",
    description: "Prove Resource isolation.",
    metadata: mutableMetadata,
  });

  mutableInput.properties.query.type = "number";
  mutableOutput.properties.answer.type = "boolean";
  mutableMetadata.provider.id = "mutated";
  assertEquals(tool.inputSchema?.properties?.query, { type: "string" });
  assertEquals(tool.outputSchema?.properties?.answer, { type: "string" });
  assertEquals(tool.metadata, { provider: { id: "original" } });
  assert(Object.isFrozen(tool.inputSchema?.properties?.query));
  assert(Object.isFrozen(tool.outputSchema?.properties?.answer));
  assert(Object.isFrozen((tool.metadata as { provider: object }).provider));
});

Deno.test("defineTool rejects non-data schema and metadata graphs", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class ClientHandle {}
  const unsafe = [
    () => "client",
    new ClientHandle(),
    new Uint8Array([1, 2, 3]),
    cycle,
  ];
  for (const candidate of unsafe) {
    const action = {
      id: "search.unsafe",
      inputSchema: { type: "object", nested: candidate },
      execute() {},
    } as never;
    assertThrows(
      () =>
        defineTool("unsafeSearch", action, {
          name: "Unsafe search",
          description: "Reject unsafe schema data.",
        }),
      TypeError,
    );
    assertThrows(
      () =>
        defineTool("unsafeSearch", searchAction, {
          name: "Unsafe search",
          description: "Reject unsafe metadata.",
          metadata: { nested: candidate },
        }),
      TypeError,
    );
  }
  const outputAction = {
    id: "search.unsafe-output",
    outputSchema: { type: "object", nested: new Uint8Array([1]) },
    execute() {},
  } as never;
  assertThrows(
    () =>
      defineTool("unsafeOutput", outputAction, {
        name: "Unsafe output",
        description: "Reject unsafe output schema data.",
      }),
    TypeError,
  );
});

Deno.test("defineTool omits schemas when its Action omits them", () => {
  const action = defineAction({
    id: "clock.now",
    execute() {
      return { now: "2026-08-23T00:00:00.000Z" };
    },
  });
  const tool = defineTool("currentTime", action, {
    name: "Current time",
    description: "Return the current time.",
  });

  assertEquals(tool.action, "currentTime");
  assertEquals("inputSchema" in tool, false);
  assertEquals("outputSchema" in tool, false);
  assertEquals("execute" in tool, false);
  assertEquals("id" in tool, false);
});

Deno.test("defineTool validates aliases and presentation without adding a host", () => {
  assertThrows(
    () =>
      defineTool("search", searchAction, {
        name: " Search ",
        description: "Search indexed documents.",
      }),
    TypeError,
    "must not contain surrounding whitespace",
  );
  assertThrows(
    () =>
      defineTool("search-tool", searchAction, {
        name: "Search",
        description: "Search indexed documents.",
      }),
    TypeError,
    "invalid Action alias",
  );
  assertThrows(
    () =>
      defineTool("search", searchAction, {
        name: "Search",
        description: "Search indexed documents.",
        execute: () => null,
      } as never),
    TypeError,
    "cannot declare 'execute'",
  );
  assertThrows(
    () =>
      defineTool("search", searchAction, {
        name: "Search",
        description: "Search indexed documents.",
        history: { visibility: "private" },
      } as never),
    TypeError,
    "invalid visibility",
  );
});
