---
name: multi-agent-setup
description: Configure public same-thread agent collaboration with the ask capability.
allowed-tools: [read_file, write_file]
tags: [framework, agent, multi-agent, ask]
---

# Multi-Agent Setup

Copilotz v3 models collaboration as public conversation. The built-in `ask` tool
creates a normal message to another agent participant; the answer is a normal
public message, and causal metadata resumes the asking agent.

```ts
const app = await createCopilotz({
  namespace: "acme",
  core: { ask: { maxDepth: 6 } },
  resources: {
    agents: [
      {
        id: "coordinator",
        name: "Coordinator",
        role: "Coordinate specialists and synthesize answers.",
        allowedAgents: ["researcher", "writer"],
        allowedTools: ["ask"],
        runtimes: { text: { type: "llm", provider: "openai" } },
      },
      {
        id: "researcher",
        name: "Researcher",
        role: "Research evidence and answer peers publicly.",
        allowedAgents: ["coordinator"],
        allowedTools: ["search_knowledge", "ask"],
        runtimes: { text: { type: "llm", provider: "openai" } },
      },
      {
        id: "writer",
        name: "Writer",
        role: "Turn evidence into clear prose.",
        allowedAgents: ["coordinator"],
        allowedTools: ["ask"],
        runtimes: { text: { type: "llm", provider: "anthropic" } },
      },
    ],
  },
});
```

Create one participant per agent in the thread, with `participantType:
"agent"`
and the corresponding `agentId`. Route the initial user input by participant ID:

```ts
const run = await app.run({
  thread: threadId,
  participant: userParticipantId,
  recipientIds: [coordinatorParticipantId],
  content: "Research this claim and draft a response.",
});
await run.done;
```

The model calls `ask` with `{ target, message }`. The target must be an agent
participant in the same thread and allowed by `allowedAgents`. Nested and
parallel asks are public and independently settled. There is no single-speaker
lock; realtime outputs remain separate participant-labelled streams.

Use a separate application-defined thread for genuinely private/background work.
Do not hide conversational collaboration behind delegation.
