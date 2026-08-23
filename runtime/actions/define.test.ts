import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineAction, isActionDefinition } from "./define.ts";
import type {
  ActionCaller,
  ActionCallers,
  ActionContext,
  ActionContextOf,
  ActionInput,
  ActionOutput,
} from "./types.ts";

interface SearchContext extends ActionContext {
  readonly resources: Readonly<{
    models: Readonly<Record<string, Readonly<{ model: string }>>>;
  }>;
  readonly adapters: Readonly<{
    llm: Readonly<Record<string, Readonly<{ provider: string }>>>;
  }>;
}

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { query: { type: "string" } },
  required: ["query"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { count: { type: "number" } },
  required: ["count"],
} as const;

Deno.test("defineAction preserves optional schemas and execute typing", () => {
  const search = defineAction({
    id: " search.query ",
    inputSchema,
    outputSchema,
    execute(input: { query: string }, context: SearchContext) {
      const model: string = context.resources.models.default.model;
      return { count: input.query.length + model.length };
    },
  });

  type InferredContext = ActionContextOf<typeof search>;
  const acceptsSearchContext = (_context: InferredContext): void => {};
  acceptsSearchContext(null as unknown as SearchContext);

  const input: ActionInput<typeof search> = { query: "hello" };
  const output: ActionOutput<typeof search> = { count: 5 };
  const caller: ActionCaller<typeof search> = (value) =>
    Promise.resolve({ count: value.query.length });
  const callers: ActionCallers<{ search: typeof search }> = { search: caller };

  assertEquals(search.id, "search.query");
  assertEquals(search.inputSchema, inputSchema);
  assertEquals(search.outputSchema, outputSchema);
  assertEquals(input.query, "hello");
  assertEquals(output.count, 5);
  assertEquals(typeof callers.search, "function");
  assert(Object.isFrozen(search));
  assertEquals(isActionDefinition(search), true);
});

Deno.test("defineAction infers typed input and output without schemas", () => {
  const increment = defineAction({
    id: "counter.increment",
    execute(
      input: Readonly<{ value: number }>,
      _context: SearchContext,
    ) {
      return Object.freeze({ value: input.value + 1 });
    },
  });

  const input: ActionInput<typeof increment> = { value: 1 };
  const output: ActionOutput<typeof increment> = { value: 2 };
  assertEquals(
    increment.execute(input, null as unknown as SearchContext),
    output,
  );
  assertEquals("inputSchema" in increment, false);
  assertEquals("outputSchema" in increment, false);
});

Deno.test("defineAction accepts only the one Action descriptor shape", () => {
  assertThrows(
    () => defineAction({ id: "", execute: () => null }),
    TypeError,
    "Action id is required",
  );
  assertThrows(
    () => defineAction({ id: "invalid action", execute: () => null }),
    TypeError,
    "cannot form an event type",
  );
  assertThrows(
    () =>
      defineAction({
        id: "grouped.action",
        actions: {},
        execute: () => null,
      } as never),
    TypeError,
    "cannot declare 'actions'",
  );
  assertThrows(
    () =>
      defineAction({
        id: "invalid.schema",
        inputSchema: [],
        execute: () => null,
      } as never),
    TypeError,
    "inputSchema must be a JSON Schema object",
  );
  assertEquals(
    isActionDefinition({
      id: "legacy.action",
      requires: {},
      execute: () => null,
    }),
    false,
  );
});
