---
title: "Models"
description: "Choose models through named LLM connections, order fallback candidates, pass request options and input limits, and plug in a custom LLM Adapter that streams frames and reports provider attempts."
section: Agent Harness
order: 10
status: stable
---

# Models

## The pain

Your assistant works against one provider in development. Then real use starts.
Production needs a different credential for each tenant. When the primary
provider has an outage, every reply fails, even though you have a second
provider you could use. CI can't call a paid model at all. And a long
conversation eventually builds a request that is too large to send.

If the agent definition holds the provider, model, key and limits together, you
have to edit the agent for each of these, and the credential ends up in a file
that tests and other hosts import.

## The problem

The application needs a clear split between three things:

- **Which model to try, in what order.** This is a durable decision that belongs
  to the agent and is recorded with every model call.
- **How to reach it.** The transport and credentials are host choices and must
  never enter durable data.
- **What a model returns.** Progressive output, a final result and an honest
  record of every provider attempt, in the same shape whether the model is a
  built-in provider, your own gateway or a test script.

## The solution

Copilotz separates these into **model selections** on the agent, **named LLM
connections** on the host, and **LLM Adapters** that make the actual call.

### Model selections on the agent

An agent's `models` maps an interaction mode (`generate` for ordinary turns,
`session` for live input-streaming interactions) to a non-empty, ordered list of
candidates. Each candidate names a connection, a model and optional JSON
`options`. For example, replace the `models` property of the agent declared in
`assistant.ts` with the following; its host must supply both named connections:

```ts
models: {
  generate: [
    {
      connection: "openai",
      model: "gpt-5.4-mini",
      // Framework admission bounds, not the provider's context window.
      options: { maxTokens: 800, limitEstimatedInputTokens: 60_000 },
    },
    // Tried only if the first candidate fails in a way that allows fallback.
    { connection: "backup", model: "backup-model" },
  ],
},
```

A selection holds no credential, URL or client. Copy model names from your
provider's current documentation; this page does not promise that any model is
available to your account.

Core records the candidates in the durable input of the `llm.call` Action.
Before any provider is contacted, it estimates the prepared request against each
candidate's `limitEstimatedInputTokens` (default 150,000) and marks the
candidate `fit` or `too_large`. For built-in providers, `maxTokens` (or
`maxCompletionTokens`) also sets the output allowance used in that estimate.
These are Copilotz's own admission bounds. Set them from your provider's
documented limits; Copilotz does not read a provider's advertised context
window. A custom adapter receives the same `options` object and decides what, if
anything, to send to its own transport.

When a Context resource supports compaction, Core consolidates ordinary history
if the first candidate is `too_large`, then prepares the request again for that
preferred model. A fitting fallback does not bypass this maintenance. History
budgets follow the first candidate's prefix, input limit and output allowance;
fallbacks remain available for provider failures. Without a compaction resource,
or within a scoped maintenance turn, LLM admission can still skip an oversized
candidate and try the next one.

The model input limit is **not** the memory consolidation trigger. Memory has
its own `triggerEstimatedTokens` setting (default 20,000) in its resource
configuration, checked when ordinary turn history is prepared. Changing one does
not change the other; see [Memory](memory.md).

Native reasoning is carried unchanged for compatible models. Its token estimate
uses the producing attempt's `reasoningTokens`, saved alongside the native
state, when available. This requires no historical usage lookup. Older OpenAI
Responses state uses an encrypted-payload byte heuristic; other formats retain a
conservative fallback until a suitable estimate is validated. These values are
heuristics, including usage-based replay estimates, and feed the same local
request calibration used by ordinary turns and consolidation. They do not count
encrypted JSON as visible text or alter the provider payload. Actual payload
bytes are tracked separately for memory-source loading limits.

### Named connections on the host

`resources.llmConnections` maps each connection name to exactly one of two
forms:

| Form              | Fields                                     | Use it for                                                               |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Built-in provider | `provider`, `auth`, optional `baseUrl`     | `openai`, `anthropic`, `gemini`, `groq`, `deepseek`, `minimax`, `ollama` |
| Custom adapter    | `adapter` only: an alias in `adapters.llm` | your gateway, a local model, scripted tests                              |

A built-in provider's `auth` is either static (`{ apiKey }`, optionally with
`extraHeaders`) or a `resolve(context, execution)` function. A resolver runs per
call with the trusted namespace, identity and Collections, and returns
`{ available: true, apiKey }` or `{ available: false, reason }`. Use it to look
up a tenant's or user's own key. A custom connection has no `provider`, `auth`
or `baseUrl`: the adapter owns its transport.

Credentials and resolvers belong only in host composition modules such as
`agent.ts`, never in Action data.

### The LLM Adapter contract

An adapter is a plain object with one method, `call(input)`. Wrap it with
`createLlmAdapter` from `@copilotz/copilotz/llm`, which validates its shape.
`call` receives `LlmAdapterCallInput`:

- `model`, `providerModel`, `adapter` (the alias), `mode` and `options` from the
  selected candidate;
- `request`: the prepared `messages`, `tools` and `instructions`;
- `fallbackAvailable`: whether another candidate follows this one;
- `signal`: aborts this attempt;
- `input`: present only in `session` mode with an input stream.

It returns `{ frames, result }` straight away:

- `frames` is a `ReadableStream` of `{ lane, mediaType, bytes }`. Each
  lane/media-type pair becomes one stream output whose `role` is the lane:
  `content` for the visible answer, `reasoning`, or `tool-calls` and
  `tool-call-drafts` for speculative tool drafts. Frames are not durable Action
  data.
- `result` resolves to `LlmAdapterResult`: `content`, optional `reasoning` and
  `toolCalls`, `finishReason`, and a **non-empty** `attempts` list. Each attempt
  has a `status` (`completed`, `failed` or `cancelled`) and optional `usage`,
  `error`, `startedAt` and `finishedAt`.

To fail, throw `LlmAdapterCallError` with the attempts you actually made. Its
`cause` stays in the process, but its message and each attempt's `error` can be
recorded and shown in failures, so keep them sanitized: no keys, headers or user
content. Report `usage` only when you really counted it.

### Fallback rules

`llm.call` tries candidates in order. Malformed agents, connections and adapter
definitions are rejected before any network I/O. Then, per candidate:

- A credential resolver that returns `available: false` skips the candidate with
  no provider attempt.
- A failed attempt moves on to the next candidate only while nothing visible has
  been published. Once a lane other than `reasoning` or the tool-draft lanes
  (for example `content`) has streamed, the failure is terminal. Reasoning and
  tool drafts from a failed attempt can be superseded by a later candidate, but
  the bytes already published stay in retained stream history.
- Cancellation never falls through, and the last candidate's failure is
  terminal.

So a backup is a chance, not a guarantee. When a call succeeds, the
`llm.call.completed` output lists every attempt, failed and completed. When it
fails, the attempts are reported as Action progress for accounting and the
Action fails; there is no successful output. Core records that as an
`llm.call.failed` Event and can still settle the operation as completed, so
readers check for that Event rather than trusting `done` alone. A fallback that
succeeds produces no `llm.call.failed` Event.

### Example: fall back from an outage

Two files, no credential, network or cost. They need Deno 2.9+ or Node 24+ with
`@copilotz/copilotz` `^0.87.1` installed as in
[setup](getting-started.md#before-you-start).

Create `scripted-models.ts`, a pure module with two custom adapters:

```ts
// The public custom-adapter contract and its failure type.
import {
  createLlmAdapter,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterResult,
} from "@copilotz/copilotz/llm";

// The fixed reply the backup streams and returns.
export const BACKUP_REPLY = "Backup model reply.";

// A primary provider that is down. It fails before publishing any frame and
// reports its one failed attempt with a sanitized message, so `llm.call` may
// try the next candidate.
export const unavailableModel = createLlmAdapter({
  call(_input: LlmAdapterCallInput) {
    const now = new Date().toISOString();
    throw new LlmAdapterCallError("Scripted provider outage.", {
      attempts: [{
        status: "failed",
        error: { code: "unavailable", message: "Scripted provider outage." },
        startedAt: now,
        finishedAt: now,
      }],
    });
  },
});

// Streams a fixed reply on the visible `content` lane, then settles with one
// completed attempt. No usage: no real tokens were counted.
export const backupModel = createLlmAdapter({
  call(input: LlmAdapterCallInput) {
    // An attempt that is already cancelled must not report success.
    input.signal.throwIfAborted();
    const result: LlmAdapterResult = {
      content: BACKUP_REPLY,
      attempts: [{ status: "completed", finishReason: "stop" }],
      finishReason: "stop",
    };
    return {
      frames: new ReadableStream({
        start(controller) {
          controller.enqueue({
            lane: "content",
            mediaType: "text/plain",
            bytes: new TextEncoder().encode(BACKUP_REPLY),
          });
          controller.close();
        },
      }),
      result: Promise.resolve(result),
    };
  },
});
```

Create `models-check.ts`, a local host that composes Core with both adapters,
sends one message and prints what `llm.call` recorded:

```ts
// Runtime factory, the stream-output guard and output types.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type {
  ActionCompletedData,
  ApplicationOutput,
} from "@copilotz/copilotz";
// Core: the agent harness, the agent helper and the chat message helper.
import { corePlugin, defineAgent, message } from "@copilotz/copilotz/core";
// Types of the recorded model call.
import type { LlmCallInput, LlmCallOutput } from "@copilotz/copilotz/llm";
import { backupModel, unavailableModel } from "./scripted-models.ts";

// A local example agent: the primary candidate is down, the backup answers.
const assistant = defineAgent({
  id: "assistant",
  name: "assistant",
  role: "A notes assistant that helps the team capture and find notes.",
  models: {
    generate: [
      { connection: "primary", model: "primary-model" },
      { connection: "backup", model: "backup-model" },
    ],
  },
  capabilities: { tools: [], agents: [], skills: [] },
});

// Reads every output: prints the visible reply, cancels other streams, and
// reports the recorded attempts or a semantic model failure.
async function report(outputs: ReadableStream<ApplicationOutput>) {
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      if (output.role === "content") {
        console.log("reply:", await new Response(output.payload).text());
      } else {
        await output.payload.cancel();
      }
      continue;
    }
    if (!output.durable) continue;
    if (output.type === "llm.call.completed") {
      const data = output.data as ActionCompletedData<
        LlmCallInput,
        LlmCallOutput
      >;
      for (const attempt of data.output.attempts ?? []) {
        console.log("attempt:", attempt.connection, attempt.status);
      }
    }
    if (output.type === "llm.call.failed") console.log("model call failed");
  }
}

// No database option: private in-memory storage for this check.
const app = await createCopilotz({
  namespace: "models-check",
  plugins: [corePlugin],
  resources: {
    agents: { assistant },
    // Both connections name custom adapters: no provider, auth or network.
    llmConnections: {
      primary: { adapter: "scripted-outage" },
      backup: { adapter: "scripted-backup" },
    },
  },
  adapters: {
    llm: {
      "scripted-outage": unavailableModel,
      "scripted-backup": backupModel,
    },
  },
});
try {
  const handle = await app.send(message({
    thread: { externalId: "models-check" },
    participant: { externalId: "you", participantType: "human" },
    recipientIds: ["assistant"],
    content: "Hello",
  }));
  // Drain outputs and settle before closing, also when either one fails.
  const results = await Promise.allSettled([
    report(handle.outputs),
    handle.done,
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
} finally {
  await app.close();
}
```

Run it:

```sh
deno run -A models-check.ts
node models-check.ts
```

Expected output, on either runtime:

```text
reply: Backup model reply.
attempt: primary failed
attempt: backup completed
```

Swap the two candidates and only `backup completed` appears. Put the outage
adapter on both connections and you get `model call failed` instead, with no
reply.

### Without Core

`llm.call` is an ordinary Action from `llmPlugin` in `@copilotz/copilotz/llm`,
registered with the alias `callLlm`. Core depends on it, but a runtime-only
application can compose `llmPlugin` with its own connections and call
`context.actions.callLlm(...)` from its own Actions or Processors, declared in
their `ActionCallers`. The selection, connection and adapter rules on this page
apply unchanged.

## What this unlocks

- Keep agent definitions pure and portable while each host picks credentials,
  per-tenant resolvers or a gateway.
- Try a second provider when the first fails before replying, with every attempt
  kept for [Usage](usage.md) accounting.
- Run agent tests and demos with scripted adapters: no credential, no cost.
- Give each candidate its own request options and admission limits.

## Next steps

- [Chapter 8: Hello Agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)
  composes the first built-in connection.
- [Chapter 14: Test Agents Without a Provider](getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
  scripts Tool calls with a custom adapter.
- [Memory](memory.md) configures when long conversations are consolidated.
- [Streams](streams.md) explains how frames become stream outputs.
