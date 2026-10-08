---
title: "Chapter 14: Test Agents Without a Provider"
description: "Replace the model provider with a scripted LLM Adapter inside a focused composed app, and check the real agent harness, Tool call and Notes state deterministically on Deno and Node."
section: Getting Started
order: 140
status: stable
---

# Chapter 14: Test Agents Without a Provider

> Part 3 — Add Agent Behavior · Track: H (recommended) · Requires: Chapters 6
> and 9 · Needs: Deno 2.9+ or Node 24+, with dependencies installed. The tests
> use no credential, network, subprocess or persistent database path.

## The pain

In Chapter 9 you checked the `saveNote` tool by running `chat.ts` against a live
model and reading the output. That check costs money, needs `OPENAI_API_KEY`,
and gives a different answer each time: sometimes the model calls the tool,
sometimes it doesn't, and the reply text always changes.

You can't put that in CI. But the parts you wrote yourself still need a test:
the grant, the Tool presentation, the `notes.save` Action, and the result going
back to the model.

## The problem

The model is the only part of an agent turn that you don't control. Everything
around it is yours: Core picks the agent, builds the request, runs the Tool's
Action, stores the note, sends the result back to the model and records the
reply. A useful test runs all of that for real and swaps out only the model.

Mocking Core, or calling `saveNote` directly, skips exactly the parts you want
to test. Importing `agent.ts` has the opposite problem: it reads the
environment, needs a credential and, after Chapter 10, starts live MCP
discovery.

## The solution

An LLM connection can name a **custom LLM Adapter** instead of a built-in
provider. An adapter is a plain object with one method, `call(input)`. Core
passes it the fully prepared request (messages, Tool definitions and
instructions). It returns `frames`, a stream of progressive output, and
`result`, a promise of the final content, Tool calls and provider attempts. The
`createLlmAdapter` helper from `@copilotz/copilotz/llm` checks that shape.

The test composes a small application of its own:

- **Plugins:** `[corePlugin, notesToolsPlugin]`. `notesToolsPlugin` brings
  `notesPlugin` with it. No `database` option, so each app gets a private
  in-memory database.
- **Agent:** the pure `assistant` definition, with its **whole** `capabilities`
  object replaced by `{ tools: ["saveNote"], agents: [],
  skills: [] }`. If
  earlier chapters granted `get_current_time`, `get_post`, a Skill, `reviewer`
  or memory tools, those aliases are not composed here. Replacing the whole
  object keeps those grants from breaking the fixture.
- **Connection:** the whole `openai` entry replaced by
  `{ adapter: "scripted" }`, with no provider or auth, and
  `adapters.llm.scripted` set to the scripted adapter.

This is an **orchestration correctness** test. It checks that your composition
turns a Tool call into the right Action, state and model request. It does not
evaluate model quality: the script decides what the "model" says.

You add three files. No existing file changes, and the Chapter 6 Notes tests
stay as they are.

| File                 | Role                            |
| -------------------- | ------------------------------- |
| `agent.scenarios.ts` | shared scenarios and the script |
| `agent.test.ts`      | Deno wrappers                   |
| `agent.node-test.ts` | `node:test` wrappers            |

No new package is needed. `@copilotz/copilotz` `^0.86.1` already provides
`/core` and `/llm`.

### The script protocol

The scripted adapter keeps no counter. On every call it looks at the request
Core prepared:

1. If the request has no `tool` message for the call ID `save-release-note`,
   this is the first model call. It returns a Tool call:
   `{ id: "save-release-note", action: "saveNote", input: { text } }`. The
   `action` value is the granted Tool alias, not the Action ID.
2. Once that `tool` message is there, Core has run the Tool and is asking again.
   The adapter records what the Tool result said, streams one deterministic
   reply on the `content` lane, and finishes. The result is a JSON part: the
   saved note, or an object with `status: "failed"` when the input was rejected.

Because the decision depends only on the request, two scenarios running at the
same time cannot affect each other. Each scenario still creates its own adapter
and app, so whatever an adapter records belongs to exactly one test.

Every result includes `attempts`, which is required and must not be empty. It
uses the provider-neutral attempt shape `{ status: "completed" }`. The script
does not imitate any provider's wire format.

### Create `agent.scenarios.ts`

```ts
// Strict assertions, available on both Deno and Node.
import assert from "node:assert/strict";
// Runtime factory, and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of the outputs and Notes Event data the scenarios read.
import type {
  ActionCompletedData,
  ApplicationOutput,
  CollectionCreated,
} from "@copilotz/copilotz";
// Core: the agent harness, and the helper that builds a chat message Event.
import { corePlugin, message } from "@copilotz/copilotz/core";
// The public custom-adapter contract.
import {
  createLlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterMessage,
  type LlmAdapterResult,
} from "@copilotz/copilotz/llm";
// Pure definitions only: never agent.ts, chat.ts, composition.ts or MCP hosts.
import { assistant } from "./assistant.ts";
import type { NoteRecord, SaveNoteInput } from "./notes-plugin.ts";
import { notesToolsPlugin } from "./notes-tools.ts";

// The scripted model's fixed Tool call ID and final reply.
const CALL_ID = "save-release-note";
// Neutral on purpose: the same reply follows a saved note and a rejected call,
// so the script never claims a success the Tool did not report.
const REPLY = "Tool result received.";

// What one scripted adapter saw: the text of each Tool result it was given.
type ScriptLog = { toolResults: string[] };

// Turns a Tool result message into text. The Notes tool returns JSON (the
// saved note, or a failure object), and this test has no file Tools, so only
// text and JSON parts are read.
function partsText(message: LlmAdapterMessage): string {
  return message.content.map((part) =>
    part.type === "text" && "text" in part
      ? part.text
      : part.type === "json" && "value" in part
      ? JSON.stringify(part.value)
      : ""
  ).join("\n");
}

// A scripted model that asks for one `saveNote` call with `text`, then replies.
// It decides from the prepared request, not a counter, and records the Tool
// result into this scenario's own log.
function scriptedModel(text: string, log: ScriptLog) {
  return createLlmAdapter({
    call(input: LlmAdapterCallInput) {
      // Core's Tool result for our call, if it has run the Tool yet.
      const toolResult = input.request.messages.find((item) =>
        item.role === "tool" && item.toolCallId === CALL_ID
      );
      // First call: request the Tool. The explicit result type gives the
      // Tool input proper JSON typing, without a cast.
      if (!toolResult) {
        const result: LlmAdapterResult = {
          content: [],
          toolCalls: [{ id: CALL_ID, action: "saveNote", input: { text } }],
          attempts: [{ status: "completed" }],
          finishReason: "tool_calls",
        };
        return {
          // No progressive output for a Tool request.
          frames: new ReadableStream({ start: (c) => c.close() }),
          result: Promise.resolve(result),
        };
      }
      // Later call: keep what the Tool returned, then stream the reply on the
      // `content` lane, which becomes the visible content stream.
      log.toolResults.push(partsText(toolResult));
      const result: LlmAdapterResult = {
        content: REPLY,
        attempts: [{ status: "completed" }],
        finishReason: "stop",
      };
      return {
        frames: new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode(REPLY),
            });
            controller.close();
          },
        }),
        result: Promise.resolve(result),
      };
    },
  });
}

// One focused app: Core plus the Notes tool, the assistant with a single grant
// and the scripted connection. No database option, so storage is private and
// in memory.
function composeApp(text: string, log: ScriptLog) {
  return createCopilotz({
    namespace: "team-notes-test",
    plugins: [corePlugin, notesToolsPlugin],
    resources: {
      agents: {
        // Replaces the whole capabilities object. Grants added in optional
        // chapters (clock, APIs, Skills, specialists, memory) are not composed
        // here and must not be left in.
        assistant: {
          ...assistant,
          capabilities: { tools: ["saveNote"], agents: [], skills: [] },
        },
      },
      llmConnections: {
        // Replaces the whole entry the assistant names: no provider, no auth.
        openai: { adapter: "scripted" },
      },
    },
    // The adapter alias that the connection above selects.
    adapters: { llm: { scripted: scriptedModel(text, log) } },
  });
}

// Everything a scenario checks after the operation settles.
type Observed = {
  notes: NoteRecord[];
  saved: NoteRecord[];
  replies: string[];
  modelCallFailed: boolean;
};

// Drains every output, keeping the Notes facts, the visible text and any
// recorded model failure. Other streams are cancelled so they don't hold the
// operation open.
async function observe(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<Observed> {
  const seen: Observed = {
    notes: [],
    saved: [],
    replies: [],
    modelCallFailed: false,
  };
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      if (output.role === "content" && output.mediaType.startsWith("text/")) {
        seen.replies.push(await new Response(output.payload).text());
      } else {
        await output.payload.cancel();
      }
      continue;
    }
    if (!output.durable) continue;
    if (output.type === "note.created") {
      seen.notes.push((output.data as CollectionCreated<NoteRecord>).record);
    }
    if (output.type === "notes.save.completed") {
      const data = output.data as ActionCompletedData<
        SaveNoteInput,
        NoteRecord
      >;
      seen.saved.push(data.output);
    }
    // Core records a failed model call and can still settle the operation.
    if (output.type === "llm.call.failed") seen.modelCallFailed = true;
  }
  return seen;
}

// Sends one chat message, reads outputs while waiting for settlement, and
// always closes the app.
async function runTurn(text: string, log: ScriptLog) {
  const app = await composeApp(text, log);
  try {
    const handle = await app.send(message({
      thread: { externalId: "agent-test" },
      participant: { externalId: "tester", participantType: "human" },
      recipientIds: ["assistant"],
      content: `Save a note saying ${text}`,
    }));
    // Wait for both the reader and settlement before cleanup, even if either
    // fails, so closing the database cannot race the reader.
    const [drained, settled] = await Promise.allSettled([
      observe(handle.outputs),
      handle.done,
    ]);
    if (drained.status === "rejected") throw drained.reason;
    if (settled.status === "rejected") throw settled.reason;
    const seen = drained.value;
    const status = await app.operationStatus({
      operationId: handle.operationId,
    });
    return { seen, state: status?.state };
  } finally {
    await app.close();
  }
}

export const agentScenarios = {
  // The full loop: model asks, Tool runs the Action, result returns, reply.
  async "a scripted Tool call saves one note and reaches the model"() {
    const log: ScriptLog = { toolResults: [] };
    const { seen, state } = await runTurn("Prepare the release.", log);

    assert.equal(seen.modelCallFailed, false);
    assert.equal(state, "completed");
    // Exactly one stored note, and one Action completion for the same record.
    assert.equal(seen.notes.length, 1);
    assert.equal(seen.notes[0].text, "Prepare the release.");
    assert.equal(seen.saved.length, 1);
    assert.equal(seen.saved[0].id, seen.notes[0].id);
    assert.equal(seen.saved[0].text, "Prepare the release.");
    // The second model call received the actual Tool result.
    assert.equal(log.toolResults.length, 1);
    assert.match(log.toolResults[0], /Prepare the release\./);
    // The deterministic reply was visible as content.
    assert.deepEqual(seen.replies, [REPLY]);
  },

  // Invalid Tool input fails Action validation. Nothing is stored, the model
  // is told about the failed call, and the turn still finishes.
  async "an invalid Tool input stores nothing and still reaches the model"() {
    const log: ScriptLog = { toolResults: [] };
    const { seen, state } = await runTurn("", log);

    assert.equal(seen.modelCallFailed, false);
    assert.equal(state, "completed");
    assert.equal(seen.notes.length, 0);
    assert.equal(seen.saved.length, 0);
    // The model received a Tool result that reports the failure. Only the
    // stable status is checked, not the validation message wording.
    assert.equal(log.toolResults.length, 1);
    assert.equal(JSON.parse(log.toolResults[0]).status, "failed");
    assert.deepEqual(seen.replies, [REPLY]);
  },
};
```

The scenarios never compare IDs to literals, error wording or timing. They
compare the note ID with itself across two Events, and the reply with the fixed
script.

### Create `agent.test.ts`

```ts
// The shared scenarios. Every check lives there.
import { agentScenarios } from "./agent.scenarios.ts";

// One Deno test per scenario, named after it.
for (const [name, scenario] of Object.entries(agentScenarios)) {
  Deno.test(`Agent: ${name}`, scenario);
}
```

### Create `agent.node-test.ts`

```ts
// Node's built-in test runner.
import { test } from "node:test";
// The same shared scenarios that `agent.test.ts` registers with Deno.
import { agentScenarios } from "./agent.scenarios.ts";

// One Node test per scenario, named after it.
for (const [name, scenario] of Object.entries(agentScenarios)) {
  test(`Agent: ${name}`, scenario);
}
```

### What this import graph can and can't reach

The test files import `assistant.ts`, `notes-tools.ts` (and through it
`notes-plugin.ts`), plus the published `@copilotz/copilotz`, `/core` and `/llm`
entry points. None of them read the environment or open a connection when
imported. Host plugins added in later chapters (the clock, OpenAPI tools, MCP
discovery, Skills roots, specialists, memory) live in `agent.ts` or other host
modules, so they can't add provider calls or MCP I/O to this test.

## Check it works

```sh
# Deno: -A grants the runtime its in-memory database and module access.
deno test -A agent.test.ts
# Node 24+: runs the same scenarios with node:test.
node --test agent.node-test.ts
```

Each runner reports two passing tests and no failures:

```text
Agent: a scripted Tool call saves one note and reaches the model ... ok
Agent: an invalid Tool input stores nothing and still reaches the model ... ok
```

The exact layout and timings depend on the runner. The first run may need the
network to download `@copilotz/copilotz` if it isn't installed or cached yet.
After that, the tests need no provider, credential or network: with
`OPENAI_API_KEY` unset, `deno test --cached-only -A --deny-net agent.test.ts`
still passes. The Chapter 6 commands (`deno test -A notes.test.ts`,
`node --test notes.node-test.ts`) still pass too.

To see the test catch a real mistake, change the grant in `composeApp` to
`tools: []`. The model's call to `saveNote` is no longer authorized, so no note
is stored and the first scenario fails. Put the grant back afterwards.

## What this unlocks

- Check in CI that grants, Tool presentations, Actions and Collection state work
  together through the real agent harness, without a credential or paid calls.
- Script any model behavior: several Tool calls, a plain answer, a refusal, or a
  failed attempt, all from the request Core prepared.
- Keep the agent tests isolated from host choices: optional integrations can
  grow in `agent.ts` without changing this test.
- Run the same assertions on Deno and Node.

## Next steps

- Next:
  [Chapter 15: Expose an HTTP API](../part-4-release-to-users/15-expose-an-http-api.md)
  gives applications and users a server for the same Notes operations.
- Reference: [Testing and Inspection](../../testing-and-inspection.md) covers
  focused compositions, observing outputs and inspecting recorded state.
- Reference: [Models](../../models.md) documents the full custom LLM Adapter
  contract: frames, results, attempts and failures.
