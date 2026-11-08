---
title: "Chapter 1: One agent, one message"
description: "Compose a runtime from two of Copilotz's plugins and one of your own, send an agent a message, and read the events it leaves."
section: Getting Started
order: 10
status: stable
---

# Chapter 1: One agent, one message

> Part 1, an agent of your own · Needs: Node 24 (an OpenAI key is optional) · Code: `lesson-1.1`

## The pain

Calling a model is one function: text in, text out. An app around it needs much more. Who said what,
and to whom? Where does the conversation live, so the next message continues it? What happened when
something fails halfway, and can it run again without doing things twice? Every app that puts an
agent in front of people ends up writing the same plumbing, usually in a hurry.

## The problem

You want the plumbing to be the platform's, with your app saying only what's yours: which agents
there are, what they're told, which model they think with. And you want every step on the record, so
you can see what happened instead of guessing.

## The solution

A Copilotz app is a **runtime** made of **plugins**. Two of Copilotz's plugins are the agentic core:

- `models` talks to model providers: OpenAI, Anthropic, Gemini, any OpenAI-compatible endpoint, and
  a `fake` provider for offline runs.
- `chat` keeps conversations (`thread`), their messages (`message`), and the agents that answer in
  them, with their tools.

Your app is a plugin too: a plain object. Here it has two **resources**, configuration as named
plain objects: a `provider` (where OpenAI is, and your key) and an `agent`, North.

Create `hello.ts`:

```ts
import process from "node:process";
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { models } from "copilotz/plugins/models";
import { chat, type Message } from "copilotz/plugins/agents";

const key = process.env.OPENAI_API_KEY;

// An app's own plugin is plain objects: here, a provider and an agent, as resources.
const app = definePlugin({
  name: "app",
  resources: {
    provider: key ? { openai: { apiKey: key } } : {},
    agents: {
      north: {
        instructions: "You are North. Be brief.",
        model: key ? "openai/gpt-6-luna" : "fake/echo",
      },
    },
  },
});

const runtime = await createRuntime({ store: memoryStore(), plugins: [models, chat, app] });

// Every event, as the runtime commits it.
runtime.subscribe((item) => {
  if (item.kind !== "event") return;
  const { seq, type, data } = item.event;
  const said = data.doc as Message | undefined;
  const what = data.action ?? data.agent ?? (said?.text ? `${said.from}: ${said.text}` : "");
  console.log(`#${seq} ${type.padEnd(17)} ${String(what).slice(0, 60)}`);
});

const { thread } = await runtime.call<{ thread: string }>("chat.send", {
  text: "Hi North. Who are you?",
});
await runtime.idle();

console.log();
for (const { from, text } of await runtime.query<Message[]>("message.history", { thread })) {
  if (text) console.log(`${from}: ${text}`);
}
await runtime.close();
```

Four calls carry the whole program:

- `createRuntime({ store, plugins })` starts the runtime. The **store** is where everything is kept;
  `memoryStore()` keeps it in memory, gone when the process ends (Chapter 5 keeps it on disk). The
  plugins are merged in order: a later plugin's resources patch an earlier one's.
- `runtime.call("chat.send", …)` calls an **Action** by name. Chat's `chat.send` writes your message
  in a new conversation and asks the conversation's agents to answer.
- `runtime.idle()` waits until nothing is left to do: here, North's turn.
- `runtime.query("message.history", { thread })` runs a named **query** on chat's `message`
  collection. Queries only read.

`runtime.subscribe` hears every event the moment it's committed. It's how you watch the record.

## Run it

```sh
node hello.ts                                 # offline: North echoes you
OPENAI_API_KEY=sk-… node hello.ts             # North on OpenAI
```

```text
#1 action.started    chat.send
#2 thread.created
#3 message.created   user: Hi North. Who are you?
#4 turn.requested    north
#5 action.completed  chat.send
#6 message.created   north: I'm North, an AI assistant. How can I help?
#7 thread.updated

user: Hi North. Who are you?
north: I'm North, an AI assistant. How can I help?
```

Offline, North's line is `You said: user: Hi North. Who are you?`: the fake model answers by
echoing, so everything else runs the same without a key.

## What the record says

Seven events, three kinds:

- **An Action's lifecycle:** `action.started` and `action.completed` (or `action.failed`) for the
  `chat.send` call, with its input and its result. Every Action call is on the record, and a call
  made again with the same id gets the first one's answer instead of running twice.
- **Collection writes:** `thread.created`, `message.created`, `thread.updated`. Every write to a
  collection records an event in the same commit as the write: the record can't miss one.
- **An event a plugin declared:** `turn.requested`. Chat declares it and emits it from `chat.send`,
  and chat's own **Processor** hears it and runs North's turn. That's why the Action completes (#5)
  before North answers (#6): the turn isn't part of the call, it's a reaction to it, run from the
  record. With a store on disk (Chapter 5), if the process died between the two, the turn would
  still be owed, and run when it starts again.

Callers call Actions; events are what Actions and writes produce. Nobody "sends an event" to make
something happen.

## What you have now

A runtime, Copilotz's agentic core and one plugin of your own. North answers, and every step it took
is in the record. In the next chapter North moves into a plugin with a home of its own, and you talk
to it in a terminal.
