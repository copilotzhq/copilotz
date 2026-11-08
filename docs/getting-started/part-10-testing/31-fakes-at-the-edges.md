---
title: "Chapter 31: Fakes at the edges"
description: "Test Compass as a person uses it, offline and in milliseconds: the app as app.ts makes it, run for real, with fakes only where it meets the world: a scripted model, a manual clock, and a model provider served on your machine."
section: Getting Started
order: 310
status: stable
---

# Chapter 31: Fakes at the edges

> Part 10, testing · Requires: Chapter 30 · Code: `lesson-10.1`

## The pain

Every plugin has its own tests, and each builds a small app of its own to run them: boards' tests
start a runtime with a scripted North, the compass plugin's tests start another. None of them runs
Compass as you use it. A change to app.ts (the model North thinks with, the order of the plugins)
can pass every test and still break the app. And the test you'd most like to have, "I ask North to
put something on the board, and it's there", seems to need a real model, a key and some patience.

## The problem

An agent's work crosses three edges you don't control. The **model** is slow, costs money and never
answers the same way twice. The **clock** makes a timer that fires in two seconds cost a test two
seconds. And the **network** is someone else's server. Everything between those edges (Actions,
rules, tools, Processors, the record) is yours, and it's deterministic. A good test runs all of that
for real and puts fakes only at the edges.

## The solution

Copilotz makes each edge something you can replace:

- **The model.** An LLM adapter is an object with `generate(request)`, which yields chunks,
  `{ type: "text", text }` and `{ type: "tool_call", call }` among them. A plugin adds one under
  `adapters.llm`, a `provider` names it (`{ script: { adapter: "script" } }`), and a `model` alias
  points at it (`north: "script/north"`). Chapter 6 did this for chat titles.
- **The clock.** `createRuntime({ clock })`. Timers run on the system's clock unless you pass
  another one. `manualClock(start)`, from `copilotz`, moves only when a test moves it
  (`advance(ms)`, `set(time)`).
- **Outside services.** `createRuntime({ fetch })` is what plugin code uses to call outside services
  (`ctx.fetch`): Copilotz's web tools, email and payments all go through it, so a test passes a fake
  there. The models plugin is the exception. It posts to its provider with the platform's own
  `fetch`, so a fake provider is a server on this machine, at the address the `provider` resource
  gives (`baseURL`).

And `copilotz/testing` is Copilotz's own test API, the one its suite runs on: `test` (on Node it's
`node:test`'s, and the same file runs under Deno and Bun), `tempDir` (a temporary directory, removed
when the test ends), `serve` (a local HTTP server that answers with your handler), and `testWho` and
`ticketFor` (saying who a request is; the next chapter uses `testWho`).

### The kit

`tests/kit.ts` holds what Compass's tests share. First, a model that plays a script:

```ts
/** What the scripted model does when it's called: says something, or calls a tool. */
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
```

A turn that calls a tool calls the model again with the tool's answer, so one move per call is the
whole protocol. `sent` keeps every request: the instructions, the tools offered, and the messages,
tool answers included. A test can check what North read as well as what it did.

Then the app, as app.ts makes it, in memory:

```ts
/** Compass, in memory: North on a script (when there are moves), Ana, and her Launch space. */
export async function compass(options: {
  /** North's moves; without them, North thinks with the model the app names. */
  moves?: Move[];
  /** OpenAI's key, as the app takes it. */
  openai?: string;
  /** What timers run on: the system's clock unless a test gives its own. */
  clock?: Clock;
  /** Plugins after the app's: a later one patches an earlier one's resources. */
  plugins?: Plugin[];
} = {}) {
  const store = memoryStore();
  const north = scripted(options.moves ?? []);
  const script = definePlugin({
    name: "test-script",
    resources: { provider: { script: { adapter: "script" } }, model: { north: "script/north" } },
    adapters: { llm: { script: north.adapter } },
  });
  const runtime = await createRuntime({
    store,
    clock: options.clock,
    plugins: [
      ...plugins({ you: { person: "ana", name: "Ana" }, openai: options.openai }),
      ...(options.moves ? [script] : []),
      ...options.plugins ?? [],
    ],
  });
  await runtime.call("person.set", { person: "ana", name: "Ana" });
  const { space } = await runtime.call<{ space: string }>("space.create", {
    name: "Launch",
  }, { actor: ana });
  return { runtime, store, space, north };
}
```

The plugins are app.ts's own (`plugins(settings)`), so every test runs the app you ship. The script
comes after them, adds its `script` provider, and patches one entry of the `model` resource: the
`north` alias, which North's agent names. Nothing else changes.

### Compass as a person uses it

`tests/app.test.ts` starts with the test you wanted:

```ts
test("North puts the work on the board, and the record says it acted for Ana", async () => {
  const { runtime, store, space, north } = await compass({
    moves: [
      { tool: "create_board", input: { name: "Course launch" } },
      {
        tool: "create_card",
        input: { title: "Record the trailer", column: "To do", assignee: "Ana" },
      },
      "I put “Record the trailer” on the Course launch board, for you.",
    ],
  });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: space,
      text: "Put the trailer on the board.",
    }, { actor: ana });
    await runtime.idle();

    // What Ana reads: North's answer, after the tools said it was done.
    const said = await runtime.query<Message[]>("message.history", { thread }, { actor: ana });
    assert.equal(
      said.at(-1)?.text,
      "I put “Record the trailer” on the Course launch board, for you.",
    );
    // What North read: the tools it was offered, and what each answered.
    assert.ok(north.sent[0].tools?.some((tool) => tool.name === "create_card"));
    assert.match(
      north.sent[2].messages.at(-1)?.text ?? "",
      /^Created “Record the trailer” .* in To do, for Ana/,
    );

    // What she'd find on the board.
    const [card] = await store.find("card", { in: space }) as Card[];
    // …
    // And the record: North made it, acting for Ana.
    const made = (await store.events(0)).find((event) => event.type === "card.created");
    assert.equal(made?.actor?.kind, "agent");
    assert.equal(made?.actor?.id, "north");
    assert.deepEqual(made?.actor?.for, ana);
  } finally {
    await runtime.close();
  }
});
```

Three model calls, three moves; everything between them is real. Ana's `chat.send` starts North's
turn, chat offers it boards' tools because the conversation is in a space, `create_card` calls
`card.create` as North acting for Ana, the rules check the write, and the store records it.
`runtime.idle()` waits until nothing is left to run, without a timer. The last check reads the
record itself: every event in the store says who did it, and `card.created`'s actor is
`{ kind: "agent", id: "north", for: { kind: "person", id: "ana" }, … }`.

### Timers, on a manual clock

Chat has a timer you can reach from a test: `chat.send`'s `quiet`. Agents answer once the sender has
been quiet that long, so a burst of short messages gets one answer. Each message sets the timer
again (`chat.quiet`). On the system's clock, this test would wait two real seconds:

```ts
test("a burst of messages gets one answer, once Ana has been quiet two seconds", async () => {
  // A clock that starts now and moves only when the test moves it.
  const clock = manualClock(Date.now());
  const { runtime, space, north } = await compass({ clock, moves: ["Both are noted."] });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: space,
      text: "The trailer",
      quiet: 2_000,
    }, { actor: ana });
    await runtime.call("chat.send", { thread, text: "and the course page", quiet: 2_000 }, {
      actor: ana,
    });
    await runtime.idle();
    clock.advance(1_000);
    await runtime.idle();
    assert.equal(north.sent.length, 0, "a second later, North still waits");
    clock.advance(1_500);
    await runtime.idle();
    assert.equal(north.sent.length, 1, "past two seconds, one answer to both");
    // …
```

It runs in a few milliseconds. The clock starts at `Date.now()` because chat dates the timer from
the wall clock (`Date.now() + quiet`); the manual clock decides when it's due. That's also why the
test moves it past two seconds, not exactly to them.

### A provider, on this machine

The last edge is OpenAI. With a key, app.ts says North thinks with `openai/gpt-6-luna` at low
effort, and titles with the same model at no effort. A test can check that without a real key. A
server on this machine (`serve`, from `copilotz/testing`) plays OpenAI, and the `provider` resource
sends calls there:

```ts
const openai = await serve(async (request) => {
  const path = new URL(request.url).pathname;
  const body = await request.json();
  asked.push({ path, key: request.headers.get("authorization"), body });
  if (path === "/embeddings") {
    const vector = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
    return Response.json({ data: [body.input].flat().map((_, index) => ({ index, embedding: vector })) });
  }
  const events = [
    { type: "response.output_text.delta", delta: "Hello, Ana." },
    { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
});
const { runtime, space } = await compass({
  openai: "sk-test",
  // The provider's address, here; the key and the models are the app's.
  plugins: [definePlugin({
    name: "test-openai",
    resources: { provider: { openai: { baseURL: openai.url } } },
  })],
});
```

The fake speaks just enough of OpenAI's Responses API (`POST /responses`, streamed as server-sent
events) for Copilotz's `openai` adapter: one piece of text, then "completed". The test then reads
what Compass sent: `/responses`, `Bearer sk-test`, the model `gpt-6-luna`, and
`reasoning: { effort: "low" }` for North and `"none"` for the title.

With a key, memory finds what it recalls with OpenAI's embeddings too (app.ts names
`openai/text-embedding-3-small`, at 512 dimensions), so the fake answers `POST /embeddings` as
well: one vector per input, in JSON. Leave that out and nothing breaks. Recall fails, memory says
so in one line, and the turn goes on without it. But a fake should speak every part of the provider
the app uses, or each run prints an error that isn't one. And since recall's call lands in `asked`
too, the test looks for the title among the `/responses` calls only.

## Run it

```text
$ node --disable-warning=ExperimentalWarning --test tests/app.test.ts
✔ North puts the work on the board, and the record says it acted for Ana (97.072917ms)
✔ a burst of messages gets one answer, once Ana has been quiet two seconds (41.011125ms)
✔ with a key, North and chat titles go to OpenAI, with the models app.ts names (48.477792ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 395.924
```

No real key, no outside network, under half a second.

## Check it

`npm test` runs these with every plugin's tests, 110 in all. A test is worth what it catches, so
break what each one covers and run it again: the model North thinks with when there's a key
(app.ts), or `create_card` in boards' tools (`resources/tools.ts`).

## Also in this chapter

- `tests/store.test.ts` takes `test` from `copilotz/testing` too, so the temporary directory each
  test made is removed when it ends.

`git diff lesson-9.2 lesson-10.1` shows every change.

## What you have now

A kit that starts Compass the way it ships, and one test of what a person does with it, from the
message to the record. Next, the other half of testing a rebuilt plugin: parity with Copilotz's own.
