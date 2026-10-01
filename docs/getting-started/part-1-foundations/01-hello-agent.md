---
title: "Ch 1: Hello Agent"
description: "Create a small Core-powered assistant and send its first message."
section: Getting Started
order: 10
status: stable
---

# Chapter 1: Hello Agent

> **Part 1 — Foundations**

## The pain

A model call is easy to start and easy to outgrow. Once an application needs a
conversation, a participant, a model connection, and a place to send the reply,
each piece needs a clear owner.

## The smallest useful change

Create one Copilotz application and send one message. The root package provides
the generic application runtime. The optional Core plugin supplies the agent
harness, and its `message()` helper packages a conversation message for
`app.send()`.

Create `assistant.ts`:

```ts
// Import the generic app factory and the stream-output type guard from the runtime.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Read the provider key from the process environment; this Node API also works in Deno.
import { env } from "node:process";
// Import the Core harness and its message-envelope helper from Core's own entrypoint.
import { corePlugin, message } from "@copilotz/copilotz/core";

// Create the application with one tenant namespace, one plugin, and one assistant.
const app = await createCopilotz({
  // Partition this application's durable records; choose the tenant at the app boundary.
  namespace: "notes-demo",
  // Add the supplied agent harness; the runtime itself remains generic.
  plugins: [corePlugin],
  // Configure the Resources consumed by the Core and LLM plugins.
  resources: {
    // Keep provider connection and credentials separate from the assistant Resource.
    llmConnections: {
      openai: {
        // Select the provider implementation for this named connection.
        provider: "openai",
        // Supply the credential at runtime; it is not part of the assistant declaration.
        auth: { apiKey: env.OPENAI_API_KEY! },
      },
    },
    // Declare the agent that will receive the first message.
    agents: {
      assistant: {
        // Give the agent a stable identity used by message routing.
        id: "assistant",
        // Give the participant a readable label in conversation history.
        name: "Notes assistant",
        // Describe the agent's purpose to the model.
        role: "A helpful assistant for capturing and finding notes.",
        // Select the model through the named provider connection.
        models: {
          // The generate list is ordered and can hold fallback model choices.
          generate: [{
            // Refer to the connection above instead of repeating its credential.
            connection: "openai",
            // Choose the model for text generation.
            model: "gpt-5.4-mini",
          }],
        },
      },
    },
  },
});

try {
  // Send a first message; Core creates the thread and participant on first use.
  const turn = await app.send(message({
    // Reuse this conversation later by keeping its external ID stable.
    thread: { externalId: "hello" },
    // Identify the human speaker with an application-owned external ID.
    participant: { externalId: "you", participantType: "human" },
    // Route this message to the declared assistant.
    recipientIds: ["assistant"],
    // Give the model the user-visible content for this turn.
    content: "Say hello!",
  }));

  // Read each output as it arrives, keeping only assistant content streams.
  for await (const output of turn.outputs) {
    // Skip non-stream outputs and any stream lane that is not user-facing content.
    if (!isStreamOutput(output) || output.role !== "content") continue;
    // Decode the content bytes into text and print this part of the reply.
    console.log(await new Response(output.payload).text());
  }

  // Wait until the operation and its in-scope work have settled.
  await turn.done;
} finally {
  // Close the application so its runtime and database resources are released.
  await app.close();
}
```

Run the file with either supported host:

```sh
# Let Deno load PGlite WASM, read the key, call the provider, and later persist data.
deno run -A assistant.ts
# Or run the ESM file with Node 24+ and its normal environment access.
node assistant.ts
```

The example needs an `OPENAI_API_KEY` in the environment. Because it does not
configure a `database`, its records live in memory for this process. It uses
Core's conversation history; it does not add a separate semantic-memory plugin.

## Breaking it down

`createCopilotz()` creates the generic application runtime. `corePlugin` adds
the supplied agent and conversation behavior on that runtime. Model credentials
belong to the LLM connection, while the agent Resource refers to that connection
by name.

The first `message()` uses an external thread ID and a human participant ID.
Core creates the conversation state on first use, then uses those same IDs to
find it on later messages. The `outputs` stream carries visible reply content;
`done` tells the caller when the operation has settled. `close()` releases the
local application.

## What this unlocks

- One complete message path from a human participant to an agent.
- A clear boundary between the generic runtime and the optional Core harness.
- Stable conversation IDs that keep later messages in the same thread.

## What's next

The assistant can reply, but the model cannot know the current time on its own.
In [Chapter 2: Your First Tool](./02-your-first-tool.md), add one local tool and
grant that capability to the assistant.
