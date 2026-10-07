---
title: "Chapter 8: Hello Agent"
description: "Compose the optional Core harness with one model connection and one agent, send a chat message, and stream the model's reply as it arrives."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: Hello Agent

> Part 3 — Add Agent Behavior · Track: H · Requires: setup only · Needs: Deno
> 2.9+ or Node 24+, and an `OPENAI_API_KEY` for the live example

## The pain

Fixed code answers only the requests it was written for. A teammate who types
"what should I note down from today's stand-up?" gets nothing, because no event
type, Processor or Action covers an open-ended question written in natural
language.

Adding a model call by hand creates a pile of new chores. Something has to keep
the conversation and who said what, pick a model and authenticate to it, send
the earlier turns along with the new one, stream the reply back, and later let
the model call tools. Written inline, all of that ends up in one script, next to
the API key.

## The problem

This is a question of **ownership**. A conversation involves three different
kinds of decision, and each belongs somewhere else:

- **Who the agent is:** its ID, its purpose and which model it should use. This
  is a definition. Tests and other applications should be able to import it
  without reading a credential or calling a provider.
- **How the host reaches the model:** which provider, and which credential. This
  is a host choice, and it differs between a laptop, a server and a test.
- **The conversation itself:** threads, participants, messages, history and
  replies. Every agent application needs this, and none of them should
  reimplement it.

The Copilotz runtime on its own is generic. `createCopilotz` composes Events,
Collections, Actions and Processors, and it includes **no** conversations,
agents or model calls. Nothing agent-related runs unless you compose it.

## The solution

Compose **Core**, the optional agent harness. `corePlugin` from
`@copilotz/copilotz/core` is an ordinary plugin on the same runtime. It brings
the LLM plugin with it, and it adds conversation threads, participants and
messages, model-backed agent turns, and the tool machinery that later chapters
use. You give it plain data: one **Agent resource** that says who the agent is,
and one named **LLM connection** that says how to reach the model.

The work splits across three files, one per module role:

| File           | Role             | Reads `env` | Imports Core |
| -------------- | ---------------- | ----------- | ------------ |
| `assistant.ts` | definition       | no          | no           |
| `agent.ts`     | host composition | yes         | yes          |
| `chat.ts`      | entrypoint       | no          | yes          |

This chapter needs only the setup step. It does not use the Notes plugin or
`composition.ts` from earlier chapters, and no runtime-track file imports any of
these three files, so the runtime track stays free of Core.

### Before you run anything: the model credential

The live example calls OpenAI, so the host needs an OpenAI API key in the
`OPENAI_API_KEY` environment variable. Your OpenAI account must have access to
the model that `assistant.ts` selects, `gpt-5.4-mini`. If it does not, change
the `model` value to one your account can use.

Set the variable in the terminal where you will run the commands. In a POSIX
shell, such as zsh or bash, this reads the key without echoing it or saving it
in your shell history:

```sh
# Type or paste the key at the prompt; nothing is shown on screen.
read -rs OPENAI_API_KEY
# Make the variable visible to programs started from this terminal.
export OPENAI_API_KEY
```

No new package is needed. Core ships in the Copilotz package you installed
during [setup](../../getting-started.md#before-you-start).

### Create `assistant.ts`

`assistant.ts` is a **definition module**. It exports one plain Agent resource
object. `as const` gives it readonly, literal TypeScript types; it does not
freeze the object at run time. The file imports nothing, reads no environment
variable and calls no factory, so any file can import it safely, including the
provider-free tests in Chapter 14.

```ts
// The Notes assistant: who it is, what it is for and which model it uses.
// Plain data, so tests and other compositions can import it without side
// effects. `as const` infers readonly, literal types for every value.
export const assistant = {
  // Stable Agent ID. Messages address the agent by this ID, and the stored
  // conversation records it as the agent's identity.
  id: "assistant",
  // Name recorded for the agent's participant in the conversation.
  name: "assistant",
  // The agent's purpose, which Core gives the model on every turn.
  role: "A notes assistant that helps the team capture and find notes.",
  models: {
    // Ordered model choices for generating replies; Core tries the first
    // choice first. `connection` names an entry that the host supplies in
    // `llmConnections`, so this file never holds a credential.
    generate: [{ connection: "openai", model: "gpt-5.4-mini" }],
  },
  // What the agent may use, granted by name. All three lists start empty and
  // later chapters append to them: Notes tools in Chapter 9, Skills in
  // Chapter 11, and other agents in Chapter 12.
  capabilities: { tools: [], agents: [], skills: [] },
} as const;
```

An empty `tools` list grants no application tools. It does not promise that the
model sees no tool definitions at all: Core may still offer its own built-in
mechanism tools, such as the one that lets an agent read back a large result
from an earlier tool call. The
[Agent Capabilities reference](../../agent-capabilities.md) describes how grants
are resolved.

### Create `agent.ts`

`agent.ts` is a **host composition module**. It decides how this host reaches
the model: it reads the credential from the environment, checks it, and pairs
the assistant with a named connection. Importing it evaluates that check, but it
does not create an application or call a provider. Later chapters add live
integrations here, such as MCP discovery in Chapter 10, so tests never import
this file; they compose their own connection instead.

```ts
// Core: conversations, agents, model calls and tools on the generic runtime.
// It brings the LLM plugin with it.
import { corePlugin } from "@copilotz/copilotz/core";
// The host environment supplies the model credential.
import { env } from "node:process";
// The pure agent definition.
import { assistant } from "./assistant.ts";

// Fail before anything is composed when the credential is missing. The message
// names the variable, never its value.
const apiKey = env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error(
    "Set OPENAI_API_KEY in the environment before running the agent.",
  );
}

// Plugins that the agent harness adds to an application. Later chapters append
// to this list.
export const agentPlugins = [corePlugin];

// Resources that Core reads when it runs an agent turn. Later chapters add
// entries to these maps.
export const agentResources = {
  // Named model connections. Agents refer to them by name; only this host
  // module holds the credential.
  llmConnections: {
    // The connection that `assistant.models.generate` names.
    openai: {
      // Core's built-in OpenAI provider.
      provider: "openai",
      // Credential used only for calls made through this connection.
      auth: { apiKey },
    },
  },
  // Agents that messages can address. The key is the composition alias;
  // messages address the agent by its `id`.
  agents: { assistant },
};
```

### Create `chat.ts`

`chat.ts` is an **entrypoint**. It composes an application from `agent.ts`,
sends one chat message with the prompt from the command line, and prints the
reply as it streams in.

A few facts about the message it sends:

- `message()` from Core turns a chat message into an ordinary input Event for
  `app.send`. Nothing here bypasses the runtime: the message is admitted,
  recorded and processed like the Notes events in Part 1.
- `thread` and `participant` use **external IDs**, which are your application's
  own names. On the first message, Core creates the thread and the human
  participant; on later messages with the same IDs, it finds and reuses them.
- `recipientIds` addresses the message to the agent with ID `assistant`, which
  enrolls the agent in the thread and asks it to reply.

The reply arrives as **stream outputs**. Core opens one byte stream per kind of
model output: `content` for the visible reply, and others such as reasoning or
tool-call drafts. `chat.ts` decodes the `content` stream piece by piece and
writes each piece as soon as it arrives. It releases the other streams. Of the
recorded Events, it watches for only one: `llm.call.failed`, which records that
a model call failed.

```ts
// Runtime factory, and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of the outputs this script reads.
import type { ApplicationOutput, StreamOutput } from "@copilotz/copilotz";
// Core's helper that turns a chat message into an input Event.
import { message } from "@copilotz/copilotz/core";
// The prompt comes from the command line; reply text goes to standard output.
import { argv, stdout } from "node:process";
// Host composition: Core, the model connection and the assistant.
import { agentPlugins, agentResources } from "./agent.ts";

// Writes one content stream to the terminal while its bytes arrive, then
// reports the stream's outcome when it did not complete.
async function printContent(output: StreamOutput): Promise<void> {
  // Decode UTF-8 incrementally, so characters split across chunks stay whole.
  const decoder = new TextDecoder();
  for await (const chunk of output.payload) {
    stdout.write(decoder.decode(chunk, { stream: true }));
  }
  // Flush any bytes buffered at the end of the stream.
  stdout.write(decoder.decode());
  stdout.write("\n");
  // `terminal` reports how this stream ended. A failed model attempt can be
  // followed by a retry on a new stream, so `done` stays the authority on
  // whether the whole operation succeeded.
  const terminal = await output.terminal;
  if (terminal.outcome !== "completed") {
    console.log(`[reply stream ended: ${terminal.outcome}]`);
  }
}

// Reads all of the operation's outputs in order, prints only the visible reply,
// and returns whether a model call failed.
async function printReply(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<boolean> {
  let modelCallFailed = false;
  for await (const output of outputs) {
    if (!isStreamOutput(output)) {
      // The recorded lifecycle Event of a model call that ended in failure,
      // after any retries and fallbacks inside that call. Only the flag is
      // kept; the Event's data, which may include provider details, is not
      // printed. Keep reading so the remaining outputs drain.
      if (output.durable && output.type === "llm.call.failed") {
        modelCallFailed = true;
      }
      // Other recorded and live Events: not printed in this chapter.
      continue;
    }
    // The agent's visible reply text.
    if (output.role === "content" && output.mediaType.startsWith("text/")) {
      await printContent(output);
      continue;
    }
    // Reasoning, tool-call drafts and other streams: release this observer's
    // copy so it does not hold the operation's outputs open.
    await output.payload.cancel();
  }
  return modelCallFailed;
}

// The prompt to send, with a default so the script runs without arguments.
const prompt = argv[2] ?? "Say hello!";

// Compose the generic runtime with the agent harness. No `database` is given,
// so conversation state lives in a private in-memory database for this
// process only.
const app = await createCopilotz({
  // Tenant namespace recorded on every conversation record and Event.
  namespace: "team-notes",
  // Core and, through it, the LLM plugin.
  plugins: agentPlugins,
  // The model connection and the assistant that Core reads.
  resources: agentResources,
});

try {
  // Admit one chat message. Core finds or creates the thread and the human
  // participant from their external IDs, records the message and runs the
  // addressed agent's turn within the same operation.
  const handle = await app.send(message({
    // Application-owned thread name; the same name reuses the same thread.
    thread: { externalId: "team-notes-chat" },
    // Application-owned identity of the human who is speaking.
    participant: { externalId: "you", participantType: "human" },
    // Agent IDs that should receive the message and reply.
    recipientIds: ["assistant"],
    // The message text.
    content: prompt,
  }));
  console.log(`accepted operation ${handle.operationId}`);

  // Wait for both the output reader and operation settlement before closing,
  // even when either fails, so cleanup cannot race the reader.
  const [drained, settled] = await Promise.allSettled([
    printReply(handle.outputs),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;
  const modelCallFailed = drained.value;
  // A settled operation is not the same as a successful reply: Core records a
  // failed model call and still settles the turn. Report it as a failure.
  if (modelCallFailed) {
    throw new Error(
      `The model call failed in operation ${handle.operationId}. ` +
        "Inspect the recorded model-call failure for details.",
    );
  }

  // Read the operation's recorded state back by its ID.
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(
    `settled operation ${handle.operationId}: ${status?.state ?? "unknown"}`,
  );
} finally {
  // Stop the runtime and release its database, including after a failure.
  await app.close();
}
```

When `OPENAI_API_KEY` is missing, importing `agent.ts` throws before
`createCopilotz` runs, and the process exits with a non-zero status.

A settled operation does not prove that the model replied. `handle.done` rejects
when delivering or preparing the turn fails. A model call that fails, for
example because of an invalid key, missing model access, a network error or an
exhausted quota, is different: Core records it as an `llm.call.failed` Event and
handles it as part of the turn, so the operation still settles as `completed`
after recording an agent-failure message; no successful model reply was
produced. That is why `chat.ts` checks for that Event separately. Retries and
fallbacks inside one successful call do not record it. When it appears, the
script throws its own error once every output has been read, `close()` runs, no
`settled operation` line is printed, and the process exits with a non-zero
status. The error names the operation, not the key or the provider's response.

### What Core keeps, and for how long

Core stores the conversation as records: the thread, its participants and every
message, including the agent's reply. On each turn it sends the model the
thread's earlier messages, so a second message in the same thread can refer to
the first. This history is the stored conversation. It is not long-term semantic
memory across conversations; [Chapter 13](./13-remember-across-conversations.md)
adds that as an optional plugin.

How long the history lasts depends on the database. `chat.ts` gives no
`database`, so each run opens a fresh in-memory database. Within one running
application, messages with the same thread external ID join the same thread.
Each new `chat.ts` process starts an empty thread, even though it uses the same
name. Keeping threads across processes needs a persistent database, which
[Chapter 7: Persist and Recover](../part-2-verify-and-recover/07-persist-and-recover.md)
introduces. Chapter 9 connects `chat.ts` to the application's shared database
choice.

## Check it works

Run `chat.ts` from the project directory with a prompt of your own, in the
terminal where you exported `OPENAI_API_KEY`:

```sh
# Deno: -A grants environment, network and database access to the runtime.
deno run -A chat.ts "Suggest three things worth noting after a stand-up."
# Node 24+: runs chat.ts and its local .ts imports by stripping type annotations.
node chat.ts "Suggest three things worth noting after a stand-up."
```

The output looks something like this. The reply's wording changes on every run,
and IDs differ on every machine:

```text
accepted operation 01K2…
Here are three things worth noting after a stand-up: …
settled operation 01K2…: completed
```

Check these facts rather than the exact text:

- An `accepted operation` line appears first.
- Reply text appears after it, written in pieces as the model produces it rather
  than all at once at the end.
- The last line is `settled operation <same ID>: completed`, and the command
  exits with status 0.

Run it again without a prompt to use the default, `Say hello!`. The reply does
not refer to your previous prompt, because the new process started a new
in-memory database.

Then check the failure path. In a new terminal where `OPENAI_API_KEY` is not
set, run the same command: the script stops with the
`Set OPENAI_API_KEY in the environment…` error, makes no model call and exits
with a non-zero status. With a key that the provider rejects, the script prints
`accepted operation`, then stops with `The model call failed in operation …` and
exits with a non-zero status instead of reporting `completed`.

## What this unlocks

The application now has a model-backed agent on the same runtime as the Notes
work, with each decision in its own place. You can:

- answer open-ended requests written in natural language, with replies that
  stream to the caller as the model produces them;
- keep the agent's identity and grants in a pure definition that tests can
  import, while only host composition holds the credential;
- change the model, or add fallback choices, in `assistant.ts` without touching
  the credential, and change the provider or key in `agent.ts` without touching
  the agent;
- address agents and reuse conversations by your own external IDs;
- keep runtime-only applications free of Core, because the harness exists only
  where you compose it.

## Next steps

- Next: [Chapter 9: Grant Tools](./09-grant-tools.md) lets the assistant save
  notes by presenting the Notes Action as a granted tool. It requires Chapters 5
  and 8, so on the fast path, work through
  [Chapters 1–5](../part-1-design-and-build/01-send-your-first-event.md) before
  it.
- Optional, with this chapter alone:
  [Chapter 11: Package Instructions as Skills](./11-package-skills.md),
  [Chapter 12: Collaborate With Specialists](./12-collaborate-with-specialists.md)
  or
  [Chapter 13: Remember Across Conversations](./13-remember-across-conversations.md).
- Reference: [Agent Capabilities](../../agent-capabilities.md) explains Agent
  resources and how tool, agent and Skill grants are resolved.
- Reference: [Models](../../models.md) covers LLM connections, providers, model
  choices and fallbacks.
