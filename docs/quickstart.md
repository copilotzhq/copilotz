---
title: "Quickstart"
description: "Run one complete runtime program that records an Event, and one optional agent program that streams a model reply, on Deno or Node."
section: Start
order: 10
status: stable
---

# Quickstart

> Track: R and H · Needs: Deno 2.9+ or Node 24+; the agent program also needs an
> `OPENAI_API_KEY`

## The pain

You want to see Copilotz do something before you read a guide. Most first
programs either hide the runtime behind an agent, so you cannot tell what is
recorded, or demand a model credential before anything runs at all.

## The problem

Copilotz has two layers with different requirements. The **runtime** records
Events and settles operations; it needs no credential and no provider. The
**agent harness**, Core, is optional: it adds conversations and model calls on
top of the same runtime, and it needs a model credential. A first program should
show each layer on its own.

## The solution

Run one of two standalone files, or both. `quickstart-runtime.ts` sends one
named input and reads back its recorded Event and operation state.
`quickstart-agent.ts` composes Core with one model connection and one agent, and
streams the reply.

### Install

Use Deno 2.9+ or Node 24+, in a new project directory.

```sh
# Deno: add Copilotz with import mappings for its plugin subpaths.
deno add jsr:@copilotz/copilotz@^0.85.2
```

Deno 2.9 holds back versions published in the last 24 hours by default. If the
release is that fresh, first add the Copilotz-only `minimumDependencyAge`
exception shown in the [Deno setup](getting-started.md#deno).

```sh
# Node: create package.json and treat .ts files as ES modules.
npm init -y
npm pkg set type=module
# Install Copilotz from JSR, and PGlite, the database the runtime opens.
npx jsr add @copilotz/copilotz@^0.85.2
npm i @electric-sql/pglite
```

### Runtime: `quickstart-runtime.ts`

No credential, provider or Core. The application has no Processors yet, so
nothing reacts to the Event and no note is saved: the program shows only that
the input is recorded and its operation settles.

```ts
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type { ApplicationOutput } from "@copilotz/copilotz";
import { argv } from "node:process";

// Prints each recorded Event; releases byte streams, which this app never opens.
async function printEvents(outputs: ReadableStream<ApplicationOutput>) {
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      await output.payload.cancel();
    } else if (output.durable) {
      console.log(`event ${output.type} id=${output.id}`);
      console.log(`  data=${JSON.stringify(output.data)}`);
    }
  }
}

// No `database`: a private in-memory database that lives until close or exit.
// The namespace is recorded on every Event this application admits.
const app = await createCopilotz({ namespace: "team-notes" });

try {
  // Commit one named input as a durable Event and start its operation. The
  // payload is plain JSON; nothing validates it or reacts to it yet.
  const handle = await app.send({
    type: "notes.capture.requested",
    payload: { text: argv[2] ?? "Prepare the release." },
  });
  console.log(`accepted operation ${handle.operationId}`);

  // Wait for the reader and settlement before cleanup, even if either fails.
  const [drained, settled] = await Promise.allSettled([
    printEvents(handle.outputs),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;

  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(`settled operation: ${status?.state ?? "unknown"}`);
} finally {
  // Release the runtime and its database, including after a failure.
  await app.close();
}
```

### Agent (optional): `quickstart-agent.ts`

This program calls OpenAI. Before running it, put an OpenAI API key in the
`OPENAI_API_KEY` environment variable of your terminal, without echoing it:

```sh
# Type or paste the key at the prompt; nothing is shown on screen.
read -rs OPENAI_API_KEY
export OPENAI_API_KEY
```

Your account must have access to `gpt-5.4-mini`, or change the `model` value.

```ts
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type { ApplicationOutput } from "@copilotz/copilotz";
import { corePlugin, message } from "@copilotz/copilotz/core";
import { argv, env, stdout } from "node:process";

// Fail before composing when the credential is missing; never print its value.
const apiKey = env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set OPENAI_API_KEY before running the agent.");
}

// Who the agent is, as plain data. Messages address it by `id`.
const assistant = {
  id: "assistant",
  name: "assistant",
  // The agent's purpose, which Core gives the model on every turn.
  role: "A notes assistant that helps the team capture and find notes.",
  // Ordered model choices; `connection` names an entry in `llmConnections`.
  models: { generate: [{ connection: "openai", model: "gpt-5.4-mini" }] },
  // Explicit grants: no application tools, agents or Skills.
  capabilities: { tools: [], agents: [], skills: [] },
} as const;

// Streams the visible reply as it arrives and returns whether a model call
// failed. Every output is drained so the operation can settle.
async function printReply(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<boolean> {
  let modelCallFailed = false;
  for await (const output of outputs) {
    if (!isStreamOutput(output)) {
      // Recorded after a model call's retries and fallbacks are exhausted.
      // Keep only the flag; its data may hold provider details.
      if (output.durable && output.type === "llm.call.failed") {
        modelCallFailed = true;
      }
    } else if (
      output.role === "content" && output.mediaType.startsWith("text/")
    ) {
      // Decode UTF-8 incrementally, so characters split across chunks stay whole.
      const decoder = new TextDecoder();
      for await (const chunk of output.payload) {
        stdout.write(decoder.decode(chunk, { stream: true }));
      }
      // Flush any bytes buffered at the end of the stream.
      stdout.write(decoder.decode());
      stdout.write("\n");
    } else {
      // Reasoning and other streams: release them so outputs can close.
      await output.payload.cancel();
    }
  }
  return modelCallFailed;
}

// No `database`: conversations live in private memory until close or exit.
const app = await createCopilotz({
  // Tenant namespace recorded on every conversation record and Event.
  namespace: "team-notes",
  // Core adds conversations, agents and model calls, and brings the LLM plugin.
  plugins: [corePlugin],
  resources: {
    // Named model connections; only host code holds the credential.
    llmConnections: { openai: { provider: "openai", auth: { apiKey } } },
    agents: { assistant },
  },
});

try {
  const handle = await app.send(message({
    // Application-owned external IDs: Core finds or creates this thread and
    // this human participant, then runs the addressed agent's turn.
    thread: { externalId: "team-notes-chat" },
    participant: { externalId: "you", participantType: "human" },
    recipientIds: ["assistant"],
    content: argv[2] ?? "Say hello!",
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
  // Core records a failed model call and still settles the turn, so `done`
  // alone does not prove the agent replied.
  if (modelCallFailed) {
    throw new Error(`The model call failed in ${handle.operationId}.`);
  }

  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(`settled operation: ${status?.state ?? "unknown"}`);
} finally {
  // Release the runtime and its database, including after a failure.
  await app.close();
}
```

## Check it works

```sh
# Deno: -A grants environment, network and database access.
deno run -A quickstart-runtime.ts "Prepare the release."
deno run -A quickstart-agent.ts "Suggest three things worth noting after a stand-up."
# Node 24+: runs the .ts files directly by stripping type annotations.
node quickstart-runtime.ts "Prepare the release."
node quickstart-agent.ts "Suggest three things worth noting after a stand-up."
```

The runtime program prints this shape; IDs change on every run:

```text
accepted operation 3f6c…
event notes.capture.requested id=3f6c…
  data={"text":"Prepare the release."}
settled operation: completed
```

Exactly one `event` line appears, its ID matches the accepted operation ID, and
the state is `completed`.

The agent program prints `accepted operation`, then reply text written in pieces
as the model produces it, then `settled operation: completed`. The wording
differs on every run. Without `OPENAI_API_KEY`, it stops before composing; with
a rejected key, it ends with `The model call failed…` and a non-zero exit
status.

Both programs use an in-memory database, so each run starts empty: a second run
keeps no Events, and the agent does not remember the previous prompt.

## What this unlocks

- **Durable generic work:** any request can become a named Event committed to
  the application's database, with an operation you can follow and query, and no
  agent or credential involved. Here that database is private memory, so the
  record lasts only while the application is open; persistence across processes
  comes in Chapter 7. Processors, Collections, Actions and Plugins build on
  this.
- **Optional agent harness:** when you want model-backed behaviour, Core adds
  conversations and streamed replies on the same runtime, configured with plain
  agent and connection data.

## Next steps

- [Getting Started Guide](getting-started.md) builds one Notes application
  across both tracks.
- [Chapter 1: Send Your First Event](getting-started/part-1-design-and-build/01-send-your-first-event.md)
  starts the runtime track.
- [Chapter 8: Hello Agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)
  splits the agent program into definition, host and entrypoint modules.
- [Documentation map](README.md) lists every guide and reference.
