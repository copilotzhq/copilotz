import { assertEquals, assertRejects } from "@std/assert";
import { createActionCallers } from "./invoker.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import type {
  ActionContext,
  ActionEffectOutcome,
  ActionSchema,
} from "./types.ts";

Deno.test("plain effect confirm refuses every occupied protected slot independently of metadata strings", async () => {
  const cases: readonly [ActionSchema, ActionEffectOutcome][] = [
    [
      secret({
        type: "object",
        properties: { ownerId: { type: "string", "x-copilotz-secret": false } },
      }),
      { ownerId: "public" },
    ],
    [secret({ type: "number" }), 27],
    [secret({ type: "boolean" }), false],
    [secret({ type: "null" }), null],
    [{ type: "object", properties: { private: secret({ type: "boolean" }) } }, {
      private: true,
    }],
  ];
  let plainConfirms = 0;
  for (const [outputSchema, output] of cases) {
    const action = defineAction({
      id: "fixture.protected-presence",
      outputSchema,
      async execute(_input: unknown, context: ActionContext) {
        await context.effect.begin("exchange");
        await context.effect.confirm("exchange", output);
        return output;
      },
    });
    const callers = createActionCallers({ run: action }, {
      signal: new AbortController().signal,
      createInvocationKey: () => crypto.randomUUID(),
      actionLifecycle: {
        emit: () => Promise.resolve({ deduplicated: false } as never),
        invoked: () => Promise.resolve(null),
        terminal: () => Promise.resolve(null),
      },
      createContext: ({ frame }) => ({ signal: frame.signal }) as ActionContext,
      createEffectClient: () => ({
        begin: () => Promise.resolve({ status: "proceed" }),
        inspect: () => Promise.resolve({ status: "none" }),
        inventory: () => Promise.resolve([]),
        confirm() {
          plainConfirms++;
          return Promise.resolve();
        },
        confirmOutput: () => Promise.resolve(),
        notStarted: () => Promise.resolve(),
      }),
    });
    await assertRejects(() => callers.run({}));
  }
  assertEquals(plainConfirms, 0);
});
