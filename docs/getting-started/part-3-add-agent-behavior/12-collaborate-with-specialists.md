---
title: "Chapter 12: Collaborate With Specialists"
description: "Add a reviewer agent, grant the assistant permission to ask it, enroll both agents in one thread, and see the assistant receive the reviewer's answer through ask."
section: Getting Started
order: 120
status: stable
---

# Chapter 12: Collaborate With Specialists

> Part 3 — Add Agent Behavior · Track: H (optional) · Requires: Chapter 8 ·
> Needs: Deno 2.9+ or Node 24+, and an `OPENAI_API_KEY` for the live example

## The pain

The assistant from Chapter 8 does everything itself. Ask it to check a release
plan and it writes the plan, judges the plan and approves the plan, all in one
voice. One role prompt can't be both a helpful writer and a strict reviewer, and
growing that prompt makes both jobs worse.

A second model call written by hand looks like an easy fix, but then the
conversation loses track of who said what. The review isn't recorded as anyone's
message, nothing decides which agent may consult which, and the assistant can't
wait for the answer and continue its turn.

## The problem

Two agents working together need three separate things, and each comes from a
different place:

1. **The specialist exists.** The host composes a `reviewer` Agent resource, so
   Core knows its role and model.
2. **The assistant may consult it.** The assistant's own definition grants the
   `reviewer` alias in `capabilities.agents`. Without that grant, the assistant
   can't ask anyone.
3. **The reviewer takes part in this conversation.** It's enrolled as a
   participant in the thread. An agent can only ask another agent that's in the
   same thread.

Neither of the last two implies the other. Addressing a message to `reviewer` in
`recipientIds` enrolls it and routes that message to it. That doesn't grant the
assistant anything. Granting `reviewer` to the assistant doesn't enroll the
reviewer in any thread.

## The solution

Core turns a non-empty `capabilities.agents` grant into the built-in **`ask`
tool**. You don't add a plugin or an executor. When the assistant's model calls
`ask` with a target and a question, Core records the question as a message from
the assistant to the reviewer and runs the reviewer's turn. When the reviewer's
answer settles, Core resumes the assistant's turn with that answer, so the
assistant can use it in its reply.

By default the ask is **public**: the question and answer become part of the
thread's shared history, so the human's conversation contains the exchange too.
The model can choose `private` mode instead, which limits that exchange to the
two agents: the question and answer stay out of the human participant's
conversation history and out of the history other participants' turns may use.
In both modes, the reviewer's answer returns to the assistant through `ask`,
separately from what the shared history shows.

These visibility rules govern participant history, not what a trusted host can
observe. `collaborate.ts` inspects the raw outputs of `app.send` as a local
diagnostic, and it prints every content stream, including the asked agent's
answer in private mode. An application-facing reader needs access-filtered views
instead, which
[Chapter 17](../part-4-release-to-users/17-connect-chat-and-channels.md) covers.

### Add the reviewer to `assistant.ts`

`assistant.ts` stays a pure definition module. Make two edits and keep
everything else as it is, including any tool or Skill grants from Chapters 9
and 11.

**Insert** this declaration at the end of `assistant.ts`, after the `assistant`
declaration:

```ts
// The release reviewer: a specialist that critiques plans instead of writing
// them. Plain data like `assistant`, so tests can import it too.
export const reviewer = {
  // Stable Agent ID. `ask` targets and message recipients use this ID.
  id: "reviewer",
  // Name recorded for the reviewer's participant in the conversation.
  name: "reviewer",
  // A narrow purpose keeps the reviewer's answers focused.
  role:
    "A release reviewer that checks a plan for risks, gaps and missing steps, " +
    "and answers with a short list of concrete findings.",
  models: {
    // The same named connection and model as the assistant; the host supplies
    // the credential.
    generate: [{ connection: "openai", model: "gpt-5.4-mini" }],
  },
  // No application Tool, Agent or Skill grants. The reviewer works from the
  // question and the conversation context it's allowed to see.
  capabilities: { tools: [], agents: [], skills: [] },
} as const;
```

**Replace** only the `agents` list inside `assistant.capabilities`. Leave the
`tools` and `skills` lists unchanged. If you skipped Chapters 9 and 11, they're
still empty:

```ts
// Agents the assistant may consult through the `ask` tool.
agents: ["reviewer"],
```

The grant names the reviewer's **composition alias**, which is its key in
`agentResources.agents`. It doesn't give the assistant access to the reviewer's
own grants. Each agent's turn runs with its own declared capabilities, and the
reviewer still has no application grants.

### Compose the reviewer in `agent.ts`

`agent.ts` remains the host composition module. Make two edits, and leave the
existing connections, plugins, integrations and other agents as they are.

**Replace** the existing `assistant` import line with this one:

```ts
// The pure agent definitions.
import { assistant, reviewer } from "./assistant.ts";
```

**Replace** only the `agents` property of `agentResources`, adding `reviewer`
next to the agents already there:

```ts
// Agents that messages can address and that granted agents may ask.
agents: { assistant, reviewer },
```

Core reads both agents from `agentResources`. It finds the `reviewer` grant on
the assistant and gives the assistant the `ask` tool. Nothing else changes in
`agent.ts`.

### Create `collaborate.ts`

`collaborate.ts` is a new entrypoint. It reuses `agentPlugins` and
`agentResources` without changing them, but it owns its own private in-memory
database. If you connected `chat.ts` to a persistent database in Chapter 9,
`collaborate.ts` doesn't see those saved notes or that history. It deliberately
starts from Chapter 8 alone and relies on enrollment within its own single
process, so it doesn't depend on Chapter 7 or on `composition.ts`.

It runs one application and sends two messages to the same thread, from the same
human:

1. **Enroll both agents.** The first message addresses
   `["assistant", "reviewer"]` and asks each agent to introduce its role. Both
   agents become participants in the thread, and both reply.
2. **Delegate.** The second message addresses only `assistant`, and asks it to
   get the reviewer's opinion on a plan. The assistant calls `ask`, Core runs
   the reviewer's turn, and the assistant continues with the answer.

Both messages go through the same application, so the second message finds the
enrollment from the first one in the same in-memory database. A separate process
would start with an empty thread.

One helper, `sendAndRead`, sends a message and reads its outputs. It labels each
content stream with the agent that produced it by using `coreStreamAgent`, and
prints the `copilotz.core.ask.completed` Event when the assistant's `ask` call
is recorded.

```ts
// Runtime factory, and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of the outputs this script reads.
import type { ApplicationOutput, StreamOutput } from "@copilotz/copilotz";
// Core's chat message helper, and the reader for the agent that produced a
// stream.
import { coreStreamAgent, message } from "@copilotz/copilotz/core";
// The plan comes from the command line; reply text goes to standard output.
import { argv, stdout } from "node:process";
// Host composition: Core, the model connection, and both agents.
import { agentPlugins, agentResources } from "./agent.ts";

// Writes one content stream to the terminal as it arrives, prefixed with the
// agent that produced it.
async function printContent(output: StreamOutput): Promise<void> {
  const agent = coreStreamAgent(output)?.id ?? "unknown";
  stdout.write(`[${agent}] `);
  // Decode UTF-8 incrementally, so characters split across chunks stay whole.
  const text = output.payload.pipeThrough(new TextDecoderStream());
  for await (const piece of text) stdout.write(piece);
  stdout.write("\n");
  // A failed attempt can be retried on a new stream; `done` and the recorded
  // Events remain the authority on the turn's outcome.
  const terminal = await output.terminal;
  if (terminal.outcome !== "completed") {
    console.log(`[${agent} stream ended: ${terminal.outcome}]`);
  }
}

// Reads every output of one operation in order. Prints agent replies and the
// recorded `ask` facts, and returns whether a model call failed.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<boolean> {
  let modelCallFailed = false;
  for await (const output of outputs) {
    if (!isStreamOutput(output)) {
      if (!output.durable) continue;
      // A model call that failed after its retries and fallbacks. Only the
      // flag is kept; provider details are not printed.
      if (output.type === "llm.call.failed") modelCallFailed = true;
      // The assistant's `ask` call was recorded. Its result only says the
      // answer is deferred; the reviewer's answer arrives as a message, and
      // Core then resumes the assistant.
      if (output.type === "copilotz.core.ask.completed") {
        console.log("event copilotz.core.ask.completed");
      }
      // The `ask` call was rejected, for example because the target isn't
      // granted or isn't in this thread.
      if (output.type === "copilotz.core.ask.failed") {
        console.log("event copilotz.core.ask.failed");
      }
      continue;
    }
    // Text content streams from every agent in this operation, as the trusted
    // host observes them, including private Ask answers.
    if (output.role === "content" && output.mediaType.startsWith("text/")) {
      await printContent(output);
      continue;
    }
    // Reasoning, tool-call drafts and other streams: release them.
    await output.payload.cancel();
  }
  return modelCallFailed;
}

// The application type, taken from the factory's result.
type App = Awaited<ReturnType<typeof createCopilotz>>;

// Sends one message from the human to the given agents in the shared thread,
// prints its outputs, and fails when delivery fails or a recorded model call
// failed.
async function sendAndRead(
  app: App,
  recipientIds: string[],
  content: string,
): Promise<void> {
  const handle = await app.send(message({
    // The same thread for both messages, so the enrollment carries over.
    thread: { externalId: "team-notes-chat" },
    // The same human for both messages.
    participant: { externalId: "you", participantType: "human" },
    // Agent IDs that receive this message and reply. Addressing an agent
    // enrolls it in the thread.
    recipientIds,
    content,
  }));
  console.log(`accepted operation ${handle.operationId}`);
  // Read outputs while waiting for settlement; either failure rejects.
  const [modelCallFailed] = await Promise.all([
    printOutputs(handle.outputs),
    handle.done,
  ]);
  if (modelCallFailed) {
    throw new Error(
      `A model call failed in operation ${handle.operationId}. ` +
        "Inspect the recorded model-call failure for details.",
    );
  }
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(
    `settled operation ${handle.operationId}: ${status?.state ?? "unknown"}`,
  );
}

// The plan to review, with a default so the script runs without arguments.
const plan = argv[2] ?? "Review a plan for releasing the Notes app.";

// The same composition as chat.ts: Core, the connection and both agents, in a
// private in-memory database for this process.
const app = await createCopilotz({
  namespace: "team-notes",
  plugins: agentPlugins,
  resources: agentResources,
});

try {
  // Turn 1: address both agents, which enrolls them in the thread.
  await sendAndRead(
    app,
    ["assistant", "reviewer"],
    "Each of you, introduce your role in one sentence.",
  );
  // Turn 2: address only the assistant, and ask it to consult the reviewer.
  await sendAndRead(
    app,
    ["assistant"],
    `Draft this plan, ask the reviewer to check it, then give me the ` +
      `revised plan: ${plan}`,
  );
} finally {
  // Stop the runtime and release its database, including after a failure.
  await app.close();
}
```

If `sendAndRead` throws on the first message, the second one is never sent,
`close()` still runs and the process exits with a non-zero status.

### What collaboration costs and guarantees

The first message makes its own model calls, at least one for each addressed
agent. If the model follows the `ask` flow on the second message, that turn
makes three calls before any retries or extra steps: the assistant decides to
ask, the reviewer answers, and the assistant resumes with the answer. The model
may also skip `ask`. Each call is billed by the provider in the usual way. This
chapter makes no promise about cost.

Collaboration doesn't merge capability grants. Each agent's turn uses only its
own declared capabilities, in the same namespace and thread, so the reviewer
can't use the assistant's Notes tool. The answer returned through `ask` is
separate from the shared history: private Tool responses aren't automatically
shared, while public Tool outputs and published messages stay visible under the
thread's normal history policy. An `ask` aimed at an agent that isn't composed,
isn't granted or isn't enrolled in the thread fails as a recorded Action
failure. Core doesn't create a new thread or enroll the agent on the fly. The
[Multi-Agent Ask reference](../../multi-agent-ask.md) covers visibility modes,
nested asks and failure handling.

## Check it works

From the project directory, in the terminal where you exported `OPENAI_API_KEY`,
run:

```sh
# Deno
deno run -A collaborate.ts "Review a plan for releasing the Notes app."
# Node 24+
node collaborate.ts "Review a plan for releasing the Notes app."
```

The output looks something like this. Wording, IDs and the order of lines within
each operation change from run to run:

```text
accepted operation 01K2…
[assistant] I'm the notes assistant: I help the team capture and find notes.
[reviewer] I'm the release reviewer: I check plans for risks and gaps.
settled operation 01K2…: completed
accepted operation 01K3…
event copilotz.core.ask.completed
[reviewer] Findings: 1. No rollback step …
[assistant] Here is the revised plan, with the reviewer's findings: …
settled operation 01K3…: completed
```

Check these facts rather than the exact text:

- The first operation shows content from both `[assistant]` and `[reviewer]`,
  and settles as `completed`.
- The second operation prints `event copilotz.core.ask.completed`, shows a
  `[reviewer]` answer even though only the assistant was addressed, and ends
  with an `[assistant]` reply that comes after the review.
- Both operations print `settled … completed`, and the command exits with
  status 0.

If the model answers without calling `ask`, no `ask` Event appears. That's a
model choice, so run the command again or make the request more explicit.

## What this unlocks

- Specialists with narrow roles and their own models, consulted by name instead
  of folded into one prompt.
- Delegation that's recorded: the question and answer are messages from
  identified participants, and the `ask` call is a recorded Action.
- Separate controls for who exists (resources), who may consult whom (grants)
  and who's in the conversation (enrollment).
- Least privilege per agent, because collaboration never merges capabilities.

## Next steps

- Next (optional):
  [Chapter 13: Remember Across Conversations](./13-remember-across-conversations.md)
  adds long-term memory. Runtime-only readers can skip the rest of Part 3.
- Reference: [Multi-Agent Ask](../../multi-agent-ask.md) for public and private
  asks, nesting depth and failure outcomes.
- Reference: [Agent Capabilities](../../agent-capabilities.md) for how tool,
  agent and Skill grants are resolved.
