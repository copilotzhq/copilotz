import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool, type ToolResource } from "./contracts.ts";

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

Deno.test("defineTool preserves its alias and copies optional Action schemas", () => {
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
  assert(tool.inputSchema === searchAction.inputSchema);
  assert(tool.outputSchema === searchAction.outputSchema);
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
  assert(Object.isFrozen(tool.history));
  assert(Object.isFrozen(tool.metadata));
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
