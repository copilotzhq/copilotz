---
title: "Ch 9: Agent Collaboration"
description: "Let one agent ask a teammate in the same public conversation."
section: Getting Started
order: 90
status: stable
---

# Chapter 9: Agent Collaboration

## The pain

A single Agent can accumulate more instructions and tools than one role should
carry. When a task needs a second specialty, the first Agent should be able to
ask that specialist and use the answer without hiding the exchange from the
conversation history.

## The solution

Core's public `ask` is a Tool backed by a durable Action. Grant the teammate in
`capabilities.agents`; Core then derives the Ask Tool and continuation
Processors. The target Agent must also already be a participant in the same
thread. A direct `message()` input enrolls each recipient, so the example first
sends a deliberate setup message to both agents. Its next message addresses only
Planner; Critic stays in the room but does not answer that message unless
Planner asks.

### Run two agents in one room

This complete `collaboration.ts` file configures Planner and Critic, enrolls
both, then sends a Planner-only request that asks Critic for a public review.
The model provider is used when the file runs; reviewing or type-checking the
example does not make a provider request.

```ts
// Import the app factory and the generic stream guard from the runtime root.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Read the provider key from the host environment rather than the source file.
import { env } from "node:process";
// Import Core's harness and typed direct-message envelope helper.
import { corePlugin, coreStreamAgent, message } from "@copilotz/copilotz/core";

// Keep the same connection/model selection for both specialist Agents.
const models = {
  // Configure one generation model choice for either Agent.
  generate: [{
    // Select the connection declared in the app's llmConnections resource.
    connection: "openai",
    // Select the model served by that connection.
    model: "gpt-5.4-mini",
  }],
};

// Compose only Core and the Resources needed for this conversation.
const app = await createCopilotz({
  // Select an explicit tenant scope for every thread and event.
  namespace: "getting-started",
  // Core already composes its LLM dependency; no channel plugin is needed.
  plugins: [corePlugin],
  // Configure one provider connection and two Agent Resources.
  resources: {
    // Keep provider authentication on the connection, not on either Agent.
    llmConnections: {
      openai: {
        provider: "openai",
        auth: { apiKey: env.OPENAI_API_KEY! },
      },
    },
    // Register the names used by message recipients and teammate grants.
    agents: {
      planner: {
        // Give this Agent a stable durable identity.
        id: "planner",
        // Give people and other Agents a readable label.
        name: "Planner",
        // Define the Agent's task-specific behavior.
        role:
          "Plan a small Notes feature and consult Critic before concluding.",
        // Select the configured LLM connection and model.
        models,
        // Grant exactly one teammate; Core derives the Ask Tool from this grant.
        capabilities: { agents: ["critic"] },
      },
      critic: {
        // Give the second Agent its own stable identity.
        id: "critic",
        // Name the specialist in streamed output and conversation history.
        name: "Critic",
        // Keep this role focused on one review perspective.
        role: "Find the biggest risk in a Notes feature plan in one sentence.",
        // Use the same provider connection while keeping a separate role.
        models,
        // Critic needs no tools or teammate grants for this example.
        capabilities: {},
      },
    },
  },
});

// Read every content stream and print the Core Agent that produced it.
async function printTurn(turn: Awaited<ReturnType<typeof app.send>>) {
  // Iterate the operation's output stream until Core closes it.
  for await (const output of turn.outputs) {
    // Ignore resolved Events and non-content stream lanes in this text display.
    if (!isStreamOutput(output) || output.role !== "content") continue;
    // Resolve each subscriber-owned byte stream after its lane completes.
    const text = await new Response(output.payload).text();
    // Read the speaker hint from Core metadata without guessing from payloads.
    const speaker = coreStreamAgent(output)?.name ?? "Agent";
    // Keep empty control output out of this minimal example's console display.
    if (text.trim()) console.log(`${speaker}: ${text.trim()}`);
  }
  // Wait for all work in the operation, including a nested public Ask, to settle.
  await turn.done;
}

try {
  // Create the room and enroll both Agents by addressing both in this first turn.
  const setup = await app.send(message({
    // An object Thread reference creates the room on first use.
    thread: { externalId: "notes-team" },
    // Identify the person who starts the conversation.
    participant: {
      externalId: "ana",
      participantType: "human",
      name: "Ana",
    },
    // Address both once so both become participants eligible for a later Ask.
    recipientIds: ["planner", "critic"],
    // Make this enrollment turn useful; both Agents answer this prompt.
    content:
      "We are planning a Notes feature. Introduce your perspective briefly.",
  }));
  // Drain both replies and wait for the setup turn to settle.
  await printTurn(setup);

  // Reuse the room, but address only Planner for the actual consultation request.
  const consultation = await app.send(message({
    // The same external ID resolves the Thread created above.
    thread: { externalId: "notes-team" },
    // Reuse the same human participant identity.
    participant: {
      externalId: "ana",
      participantType: "human",
      name: "Ana",
    },
    // Critic remains a participant but receives no direct reply request here.
    recipientIds: ["planner"],
    // Planner should use its granted Ask Tool before giving the combined answer.
    content:
      "Plan a save-note feature. Ask Critic for the largest risk, then summarize.",
  }));
  // This operation settles only after Planner's Ask branch and continuation finish.
  await printTurn(consultation);
} finally {
  // Close the application-owned database and execution resources on success or error.
  await app.close();
}
```

The first message deliberately receives two answers. It solves the membership
prerequisite using the supported Core input shape (`recipientIds`), not a
nonexistent `participants` property on `message()`. In a server-backed room, the
typed Core client can separately enroll agents with `participantIds` and choose
who answers with `recipientIds`; see
[Chapter 11](../part-3-production/11-http-and-client.md).

Core records the question, answer, causation, and Action lifecycle. An Ask
branch settles only when the asked Agent finishes its own work, so `turn.done`
waits for the follow-up answer and Planner's continuation.

## What this unlocks

Specialists can contribute through a conversation that people and Agents can
inspect. Exact teammate grants keep the collaboration graph intentional, and the
same durable execution model handles ordinary turns and nested questions.

## What's next

Agent collaboration answers questions inside one conversation. Longer-lived
facts and source documents have different lifecycles.
[Chapter 10: Memory and Knowledge](10-memory-and-knowledge.md) explains when to
add either plugin.
