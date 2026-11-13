# Testing a Copilotz app, offline

Every test runs the app as `app.ts` makes it, with fakes only where it meets the world: a scripted
model, a manual clock, a fake `fetch`. None needs an API key or the network. Run `npm test` after
every change, and `npm run check` before you stop. AGENTS.md ("Test without an API key") is the
source of truth for the installed version.

## The kit: the app, in memory, with a scripted model

`tests/kit.ts`. The scripted model is an `LlmAdapter` that plays its moves in order, one per call (a
text, or a tool call), and keeps every request it got. `start` points the agents' model alias
(`helper`, here) at it through a provider of its own.

```ts
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import type { LlmAdapter, LlmRequest } from "copilotz/plugins/models";
import { plugins } from "../app.ts";

export type Move = string | { tool: string; input?: Record<string, unknown> };

/** A model that plays its moves in order, one per call, and keeps what each call sent it. */
export function scripted(moves: Move[]) {
  const sent: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    async *generate(request) {
      sent.push(request);
      const move = moves.shift();
      if (move === undefined) throw new Error(`The script has no move for call ${sent.length}.`);
      if (typeof move === "string") yield { type: "text", text: move };
      else {
        const call = { id: `call-${sent.length}`, name: move.tool, input: move.input ?? {} };
        yield { type: "tool_call", call };
      }
    },
  };
  return { adapter, sent };
}

/** The app, in memory, with the `helper` alias on a script. */
export async function start(moves: Move[] = []) {
  const store = memoryStore();
  const helper = scripted(moves);
  const script = definePlugin({
    name: "test-script",
    resources: { provider: { script: { adapter: "script" } }, model: { helper: "script/helper" } },
    adapters: { llm: { script: helper.adapter } },
  });
  const runtime = await createRuntime({ store, plugins: [...plugins(), script] });
  return { runtime, store, helper };
}
```

## An agent's turn: what the model read, the record, what a person sees

A turn with one tool call takes two moves: the tool call, then the answer after the model reads the
tool's View. `await runtime.idle()` waits until nothing is left to run.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, personOf } from "copilotz";
import { start } from "./kit.ts";

test("the agent adds a task for Ana, through the same Action", async () => {
  const { runtime, store, helper } = await start([
    { tool: "add_task", input: { title: "Bo" } },
    "Done.",
  ]);
  try {
    const ana: Actor = { kind: "person", id: "ana" };
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const here: Actor = { ...ana, in: space };
    await runtime.call("chat.send", { in: space, text: "Add Bo." }, { actor: here });
    await runtime.idle();
    // What the model read after its tool call: the tool's View.
    assert.match(String(helper.sent[1].messages.at(-1)?.text), /^- \[ \] Bo \(.+\)$/);
    // The record: written for Ana, by the agent.
    const made = (await store.events(0)).find((e) => e.type === "task.created");
    assert.equal(personOf(made?.actor), "ana");
    assert.equal(made?.actor?.kind, "agent");
    // What Ana sees, as the page or the terminal would.
    const seen = await runtime.observe<string>("tasks", {}, { actor: here }).ready;
    assert.equal(seen.status, "ready");
  } finally {
    await runtime.close();
  }
});
```

## What callers may not do

Call as someone else, and expect the refusal by its code. The rules answer for the data, so another
person's task isn't "forbidden" to them: it isn't there.

```ts
test("a contact can't add tasks, and Bo can't finish Ana's", async () => {
  const { runtime } = await start();
  try {
    const ana: Actor = { kind: "person", id: "ana" };
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { task } = await runtime.call<{ task: string }>("task.add", { title: "Pay rent" }, {
      actor: { ...ana, in: space },
    });
    const visitor: Actor = { kind: "contact", id: "c-1", in: space };
    await assert.rejects(runtime.call("task.add", { title: "Hi" }, { actor: visitor }), {
      code: "forbidden", // `allow: people`
    });
    const bo: Actor = { kind: "person", id: "bo" };
    const mine = await runtime.call<{ space: string }>("space.personal", {}, { actor: bo });
    await assert.rejects(
      runtime.call("task.done", { task }, { actor: { ...bo, in: mine.space } }),
      {
        code: "not_found", // the rules filtered it out
      },
    );
  } finally {
    await runtime.close();
  }
});
```

## Time, outside calls and HTTP

Fakes go in through `createRuntime`. To use them with the kit, let `start` take options and pass
them on (`createRuntime({ ...options, store, plugins })`).

- **Time:** `manualClock(start)`, from `copilotz`, moves only when a test says so. Pass it as
  `createRuntime({ clock })`: `clock.advance(ms)` fires what comes due, and `await runtime.idle()`
  waits for it to finish. A declared schedule
  (`schedules: { ping: { every: "1m", call: "ping.run", input: {} } }`) runs once per
  `clock.advance(60_000)`.
- **Outside calls:** `createRuntime({ fetch })` sets what plugins' `ctx.fetch` calls. Answer with
  `new Response(…)` and assert on the requests it got.
- **A model provider** is called with the platform's `fetch`, not `ctx.fetch`. To fake one over
  HTTP, run a local server (`serve(handler)`, from `copilotz/testing`, gives its `url`) and set it
  as the provider's `baseURL`:
  [fakes at the edges](https://copilotz.com/docs/build-compass/part-10-testing/31-fakes-at-the-edges.md).
- **HTTP without a port:** `await runtime.fetch(new Request("http://localhost/…"))` answers routes,
  the REST API at `/api/` and MCP at `/mcp/<name>`. One test can then check every way in:
  [the same bookings, every way in](https://copilotz.com/docs/getting-started/06-the-same-bookings-every-way-in.md).
- **Web Views:** Node doesn't run `.tsx`. Tests that load a `web.tsx` need the loader hook from
  [Getting Started, chapter 3](https://copilotz.com/docs/getting-started/03-its-own-web-page.md).

## When a test fails

- **"The script has no move for call N."** The app called the model more times than the script has
  moves: a tool call is followed by another call, after the model reads the tool's View.
- **A View still `loading`:** read it with `runtime.observe(…).ready`, after `await runtime.idle()`.
- **`forbidden` where you expected a write:** check the actor's `in` (where the work is) and the
  Action's `allow`, before you touch the rules.
- **The runtime won't start:** a `requires` plugin is missing, a model alias names no provider, or a
  schedule's input doesn't match its Action's schema. The error says which.
