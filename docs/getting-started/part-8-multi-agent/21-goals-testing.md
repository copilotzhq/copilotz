---
title: "Ch 21: Goals — Automated Testing & Agent Simulation"
description: "Test agents with agents; score multi-turn conversations with a judge."
section: Getting Started
order: 210
status: stable
---

# Chapter 21: Goals — Automated Testing & Agent Simulation

> **Part 8 — Multi-Agent Systems**

## The pain

You've built a conversational agent. It handles common cases well in manual testing. But how do you know it still handles them correctly after you change the prompt? How do you verify it completes a multi-turn booking flow before you ship? How do you catch regressions in behavior — not just code?

Manual QA doesn't scale. Scripted unit tests can't capture emergent LLM behavior. And you can't mock your way to confidence in something that only exists in conversation.

## The solution

`copilotz.goal()` lets you simulate multi-turn conversations programmatically — using one agent to play the user, another as the tested agent, and optionally a third to judge the outcome. All three run inside the same Copilotz runtime, so you get full observability, the real prompt construction, and real tool calls. You're not mocking anything.

The loop has three phases:

1. **Target** — the agent under test receives a message and responds
2. **Lead** — the simulated-user agent reads the target's response and generates the next message
3. **Judge** (optional) — after the conversation ends, an evaluator agent grades the transcript

## Basic usage

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "support",
      name: "Support Agent",
      role: "Customer support for an airline.",
      instructions: "Help customers book flights, check status, and handle rebookings.",
      llmOptions: { provider: "openai", model: "gpt-4o" },
    },
    {
      id: "simulated-user",
      name: "Simulated User",
      role: "A traveler trying to rebook a cancelled flight.",
      instructions: `
        You are playing a customer whose flight was cancelled.
        Your goal: get rebooked on the next available flight to Paris.
        Be realistic — ask for confirmation before accepting, express mild frustration.
      `,
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

const handle = await copilotz.goal({
  // The opening message — what the simulated user says first
  content: "My flight to Paris was cancelled. I need to be rebooked.",
  sender: {
    id: "traveler-01",
    type: "user",
    name: "Alice",
    usingAgent: "simulated-user",  // This agent generates each user turn
  },
  target: "support",               // This agent is being tested
  thread: {
    externalId: "booking-test-001",
    participants: ["support"],
  },
  maxTurns: 10,
  stop: ({ lastMessage, turns }) => {
    // Stop when the target confirms a rebooking or we hit the turn limit
    if (lastMessage?.content.toLowerCase().includes("confirmed")) {
      return { stop: true, status: "completed", reason: "rebooking confirmed" };
    }
    return false;
  },
});

// Stream events as they happen (optional)
for await (const event of handle.events) {
  if (event.type === "NEW_MESSAGE") {
    const payload = event.payload as { sender?: { name?: string }; content?: string };
    console.log(`[${payload.sender?.name}]: ${payload.content}`);
  }
}

const result = await handle.done;

console.log("Status:", result.status);      // "completed" | "failed" | "stopped" | "cancelled" | "error"
console.log("Turns:", result.turns);
console.log("Duration:", result.metrics.durationMs, "ms");
```

## The `stop` callback

`stop` runs after each target-agent turn. Return `true` to halt with status `"stopped"`, or a full object to set the status and reason explicitly:

```typescript
stop: ({ lastMessage, turns, transcript }) => {
  // Successful completion
  if (lastMessage?.content.includes("Booking confirmed")) {
    return { stop: true, status: "completed", reason: "booking confirmed" };
  }
  // Detect failure condition
  if (lastMessage?.content.includes("cannot help")) {
    return { stop: true, status: "failed", reason: "agent gave up" };
  }
  // Let it continue
  return false;
}
```

The `stop` context gives you:
- `lastMessage` — the target agent's most recent reply
- `transcript` — the full conversation so far
- `turns` — how many target turns have completed
- `threadId` / `leadThreadId` — IDs of both threads
- `events` — all raw events from all phases

## The `evaluate` callback and judge agents

After the conversation loop ends, `evaluate` runs once. It receives the full transcript and a `run()` function that lets you invoke another agent as a judge:

```typescript
const handle = await copilotz.goal({
  content: "I need to cancel my order.",
  sender: {
    id: "customer-01",
    type: "user",
    name: "Bob",
    usingAgent: "simulated-customer",
  },
  target: "support",
  thread: { externalId: "cancel-test-001", participants: ["support"] },
  maxTurns: 8,

  evaluate: async ({ transcript, run }) => {
    // Build a summary for the judge
    const transcriptText = transcript
      .map(m => `${m.senderName} (${m.phase}): ${m.content}`)
      .join("\n");

    // Use a judge agent to assess the conversation
    const judgment = await run({
      content: `
        Evaluate this support conversation. Did the agent:
        1. Acknowledge the customer's request clearly?
        2. Complete the cancellation or explain why it couldn't?
        3. Remain professional throughout?

        Transcript:
        ${transcriptText}

        Reply with: PASS or FAIL, a score from 0.0 to 1.0, and one sentence of reasoning.
      `,
      sender: { id: "goal-system", type: "system", name: "Goal" },
      target: "judge",
      thread: { externalId: "cancel-test-judge-001", participants: ["judge"] },
    });

    const passed = judgment.text.includes("PASS");
    const scoreMatch = judgment.text.match(/(\d+\.\d+)/);

    return {
      name: "conversation-quality",
      status: passed ? "completed" : "failed",
      score: scoreMatch ? parseFloat(scoreMatch[1]) : undefined,
      report: judgment.text,
    };
  },
});

const result = await handle.done;
console.log("Score:", result.score);         // Average across all assessments
console.log("Report:", result.report);       // Combined assessment text
console.log("Assessments:", result.assessments);
```

The judge agent is a regular Copilotz agent — define it in your agent list and reference it in `evaluate`. It runs in its own thread (the "judge phase") and its events appear in the stream annotated with `goalPhase: "judge"`.

## The GoalResult

`await handle.done` resolves to:

```typescript
{
  id: string;              // Unique goal ID
  status: "completed" | "failed" | "stopped" | "cancelled" | "error";
  score?: number;          // Average score across all assessments (0.0–1.0)
  report?: string;         // Combined text from all assessment reports
  reason?: string;         // Why the loop stopped
  threadId: string;        // The target agent's thread
  leadThreadId: string;    // The lead (simulated user) agent's thread
  turns: number;           // How many target turns ran
  transcript: GoalTranscriptMessage[];  // Every message, in order
  assessments: GoalAssessment[];        // All judge outputs
  metrics: {
    durationMs: number;
    targetRuns: number;    // How many times the target agent ran
    leadRuns: number;      // How many times the lead agent ran
    judgeRuns: number;     // How many times evaluate called run()
    messages: number;      // Total messages in transcript
    toolCalls: number;     // Tool calls across all phases
    errors: number;
  };
}
```

## The transcript

`result.transcript` is a flat array of every message from all three phases, in order. Each entry has:

```typescript
{
  turn: number;         // Which turn this belongs to
  phase: "target" | "lead" | "judge";
  senderId?: string;
  senderName?: string;
  senderType?: string;  // "user" | "agent" | "tool"
  content: string;
}
```

Tool results from the target thread are **not** passed to the lead agent — it only sees the target's final text reply. This matches how a real user would experience the conversation and keeps the lead agent from being confused by internal tool output.

## Isolation: the lead and target have separate threads

The target agent runs in its own thread (with real conversation history). The lead agent runs in a separate private thread — it only sees the text of each agent reply, not the full thread history or tool results. This prevents the simulated user from being influenced by the agent's internal state, which would undermine the simulation.

## Running goals in a test suite

Goals work well as integration tests run with `deno test`:

```typescript
// tests/booking_flow_test.ts
import { assertEquals } from "@std/assert";
import { createCopilotz } from "@copilotz/copilotz";

Deno.test("support agent completes booking within 6 turns", async () => {
  const copilotz = await createCopilotz({ /* ... */ });

  const handle = await copilotz.goal({
    content: "I need to book a flight to Tokyo for next Tuesday.",
    sender: {
      id: "test-user",
      type: "user",
      name: "Test User",
      usingAgent: "simulated-traveler",
    },
    target: "support",
    thread: { externalId: "test-booking", participants: ["support"] },
    maxTurns: 6,
    stop: ({ lastMessage }) =>
      lastMessage?.content.includes("confirmed")
        ? { stop: true, status: "completed" }
        : false,
  });

  for await (const _ of handle.events) { /* drain */ }
  const result = await handle.done;

  assertEquals(result.status, "completed");
  assertEquals(result.turns <= 6, true);

  await copilotz.shutdown();
});
```

## What this unlocks

- End-to-end multi-turn conversation testing without manual QA
- Simulated users that behave realistically — full LLM reasoning, not scripted replies
- LLM-as-judge evaluation: an agent grades the transcript and returns a structured score
- Full observability: every target, lead, and judge event flows through the same stream as a normal run, annotated with `goalPhase`
- Integration into `deno test` — goals are async, return structured results, and can drive assertions directly

## What's next

Your agents now run on a specific LLM provider. What if you want to route some calls to a new model, or run on a provider Copilotz doesn't officially support yet?

→ **[Chapter 22: Custom LLM Providers](../part-9-customization/22-custom-llm-providers.md)**
