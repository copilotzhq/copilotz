---
title: "Chapter 6: Chats that name themselves"
description: "Write a Processor: it hears chat's message.created events and names new chats with a small model. Then test it with a scripted model, swapped in through resources and an adapter."
section: Getting Started
order: 60
status: stable
---

# Chapter 6: Chats that name themselves

> Part 2, your own plugins · Requires: Chapter 5 · Code: `lesson-2.3`

## The pain

The sidebar lists chats by their first message: "Hi North. Who are you?", "ok so about that thing".
A week later, none of them says what it was about.

## The problem

Naming a chat is something that should _happen_ when you write in one: not part of sending (the
message shouldn't wait for it, or fail with it), and not something every way of sending has to
remember. It's a reaction to an event, and it has to survive a crash: if the process stops before
the name is written, the name is still owed.

## The solution

A **Processor**: code that runs when events happen. It names the events it hears (`on`), filters
them (`where`, a MongoDB filter on the event's data), and says which ones must run in order (`key`).
The runtime runs it from a durable cursor, at least once for each event it matches.

`plugins/compass/processors/title.ts`:

```ts
import type { ProcessorDef } from "copilotz";
import type { Message, Thread } from "copilotz/plugins/agents";

export const titleProcessor: ProcessorDef = {
  on: "message.created",
  // People's messages only: an agent's answer has the `turn` that wrote it.
  where: { "doc.turn": { $exists: false } },
  // One chat's messages in order; different chats at once.
  key: (event) => String((event.data.doc as Message).thread),
  run: async (ctx, event) => {
    if (!(ctx.resources.model as Record<string, unknown> | undefined)?.titles) return;
    const message = event.data.doc as Message;
    const threads = ctx.db.collection<Thread>("thread");
    const thread = await threads.findOne({ _id: message.thread });
    if (!thread || thread.title || !message.text) return;
    const { text } = await ctx.call<{ text: string }>("llm.generate", {
      model: "titles",
      instructions: "Name this conversation in at most five words, in the language it's " +
        "written in. Answer with the name alone.",
      messages: [{ role: "user", text: message.text }],
    });
    const title = text.trim().replace(/^["'“]|["'”.]$/g, "").slice(0, 120);
    if (title) await threads.updateOne({ _id: thread._id }, { $set: { title } });
  },
};
```

Things to notice:

- **It hears another plugin's events.** `message.created` is chat's: every write to chat's `message`
  collection records it. Compass doesn't import chat's code; it hears its events by name, and reads
  and writes its `thread` collection by name.
- **At least once means it may run twice.** If it fails, or the process stops halfway, it runs again
  for the same event. So it asks first whether the chat already has a title: running twice is
  harmless. Every Processor should be safe to run again.
- **The model is an alias.** `llm.generate` is the models plugin's Action: one call, the whole
  answer. Which model `titles` means is the app's choice (`app.ts`, `gpt-6-luna` with no reasoning).
  With no key, the app sets no `titles` model, and chats keep their first message: the offline model
  only echoes, which would make poor names.

In `mod.ts`, the plugin declares it by a name of its own:

```ts
processors: {
  "compass.title": titleProcessor,
},
```

And `app.ts` says what `titles` is, only when there's a key:

```ts
model: {
  // What North thinks with: the `north` model alias its agent names.
  north: settings.openai ? { model: "openai/gpt-6-luna", effort: "low" } : "fake/echo",
  // What names chats: small and cheap. Offline, chats keep their first message.
  ...(settings.openai ? { titles: { model: "openai/gpt-6-luna", effort: "none" } } : {}),
},
```

## Run it

In the terminal, start two chats (`/new` starts the second), each about one thing. Then look in the
store, the way Chapter 5 did:

```text
$ sqlite3 -header -column .data/compass.sqlite "SELECT title FROM thread"
title
---------------------------------
Lançamento do Curso em Dezembro
Reunião de design na quinta-feira
```

Named in the language you wrote in. In the browser, a chat's header shows its name too.

## Check it

A Processor that calls a model needs a model in its test, one that answers the same every time. Two
primitives make that a few lines: a **resource** says where the `titles` model is, and an
**adapter** is the implementation behind it. An `llm` adapter named `script` speaks for a provider
named `script`:

```ts
test("a new chat is named once, from its first message, by the titles model", async () => {
  // A scripted model for titles: it says what it was asked to name, shortened.
  const asked: string[] = [];
  const script: LlmAdapter = {
    async *generate({ messages }) {
      const said = messages.map((m) => ("text" in m ? m.text : "")).join(" ");
      asked.push(said);
      yield { type: "text", text: `"Plan the launch"` };
    },
  };
  const titles = definePlugin({
    name: "titles-model",
    resources: { provider: { script: { adapter: "script" } }, model: { titles: "script/titles" } },
    adapters: { llm: { script } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [...plugins({ you: { person: "ana" } }), titles],
  });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      text: "Let's plan the course launch for December",
    });
    await runtime.call("chat.send", { thread, text: "And the trailer too" });
    await runtime.idle();
    const found = await runtime.query<{ _id: string; title?: string }[]>("thread.recent", {});
    // Named once, from the first message; quotes taken off.
    assert.equal(found.find((t) => t._id === thread)?.title, "Plan the launch");
    assert.deepEqual(asked, ["Let's plan the course launch for December"]);
  } finally {
    await runtime.close();
  }
});
```

The test's plugin comes last, so its resources patch the app's: the same way an app customizes a
plugin it didn't write, a test swaps a model for a script.

## What you have now

All six primitives, in code you wrote: collections, Actions, a Processor, Views, resources and an
adapter. Next you rebuild a plugin that other plugins depend on: spaces.
