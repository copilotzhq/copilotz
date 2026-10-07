---
title: "Goals"
description: "Run a bounded back-and-forth between two Agents with Core's runGoal Action: policy, conversation Adapter, turn limits, retries and what the result does and does not prove."
section: Agent Harness
order: 90
status: stable
---

# Goals

## The pain

A writer Agent drafts release notes and a reviewer Agent critiques them. You
want the two to iterate until the reviewer is satisfied, without a human
relaying every message. Written by hand, that loop sends a message, waits for
the reply, copies it to the other Agent and repeats. It also has to answer the
hard questions: when does it stop, what happens if the process retries halfway
through, and how does a caller learn the outcome?

## The problem

An ordinary chat message settles when the work it started settles. That work may
reach several Agents or nested Asks, but a single submission carries no policy
for "keep relaying between these two until a condition holds", and an unbounded
relay can loop forever, double-send on retry or report success just because each
send settled. The loop needs:

- a hard turn limit and an explicit stop decision;
- stable admission identities and an explicit recovery boundary for a loop
  interrupted before its Action records a terminal outcome;
- a way to reach the application's own `send` without the Action creating a
  second application;
- a result that names its outcome, separate from whether the Action ran.

## The solution

Core already registers the `copilotz.core.goal.run` Action under the alias
`runGoal`, plus a default policy at `resources.goals.default` with
`{ maxTurns: 20 }`. There is no Goal plugin, `defineGoal` or Goal manager to
install. You supply three things:

1. **A policy** (`GoalPolicy`): `maxTurns`, an optional conversation Adapter
   alias and an optional `decide` function.
2. **A conversation Adapter** at `adapters.conversation.default` (or the alias
   the policy names) whose `send` is the same application's public `send`.
3. **A caller**: any Action or Processor context that invokes `runGoal`.

Each round sends the current content to the **target** scope and waits for that
send to settle, including Tool continuations. The target Agent's final Message
is recorded as a `GoalTurn`, and `decide` is asked about it. On `"continue"`,
the reply goes to the **lead** scope, and the lead's reply becomes the next
target input. With `N` maximum turns there are at most `N` target turns and
`N - 1` lead sends. Model and Tool calls inside each turn are not counted.

### Run a two-Agent review

Before you start, use Deno 2.9+ or Node 24+ in a project set up as in the
[Quickstart install](quickstart.md#install): on Deno,
`deno add jsr:@copilotz/copilotz@^0.85.5`; on Node, an ES module project
(`npm pkg set type=module`) with `npx jsr add @copilotz/copilotz@^0.85.5` and
`npm i @electric-sql/pglite`. No credentials are needed: a scripted LLM Adapter
answers every call, so no provider is contacted.

The script returns the same reply every time, and the policy only counts turns.
`decide` runs after each **target** (writer) reply, not after the reviewer's,
and here it completes on turn 2 whatever the replies say. That makes the loop
shape deterministic, but it is a fixture. Nothing here judges the draft, and a
Goal never accepts a review automatically: a real policy must evaluate whatever
evidence it can reach.

Create `goal-review.ts`:

```ts
// Runtime factory, Processor helper and the guard for byte streams.
import {
  createCopilotz,
  definePlugin,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types for the late-bound app, the typed Processor context and Goal progress.
import type {
  ActionCallers,
  ActionProgressData,
  ApplicationOutput,
  CopilotzApplication,
  ProcessorContext,
} from "@copilotz/copilotz";
// Core harness, which already registers `runGoal` and the default Goal
// policy, and the policy's type.
import { corePlugin, type GoalPolicy } from "@copilotz/copilotz/core";
// The Goal Action's public definition and types.
import {
  type GoalConversationAdapter,
  type GoalTurn,
  runGoalAction,
  type RunGoalInput,
} from "@copilotz/copilotz/goals";
// The public custom LLM Adapter contract.
import {
  createLlmAdapter,
  type LlmAdapterResult,
} from "@copilotz/copilotz/llm";

// Fixed reply for every model call. Real content arrives as a ContentSequence.
const REPLY = "Draft reviewed.";

// A scripted model that keeps no state: every call streams the same reply.
const scriptedModel = createLlmAdapter({
  call() {
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

// Both Agents use the scripted connection and receive no capability grants.
// The Goal relay is not a Tool, so neither Agent needs one.
const agent = (id: string, role: string) => ({
  id,
  name: id,
  role,
  models: { generate: [{ connection: "scripted", model: "fixture" }] },
  capabilities: { tools: [], agents: [], skills: [] },
});

// Fixture policy: runs after each writer reply and counts turns only. It
// judges nothing. A real policy must evaluate evidence it can reach.
const reviewPolicy: GoalPolicy = {
  maxTurns: 5,
  decide: ({ turn }) =>
    turn >= 2
      ? {
        status: "completed",
        reason: "Fixture completed after two target turns.",
      }
      : "continue",
};

// The Processor's context declares the one Action it calls, so TypeScript
// checks the Goal input and result.
type ReviewContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ runGoal: typeof runGoalAction }>
>;

// Starts one Goal for every stored review request.
const startReview = defineProcessor<ReviewContext>({
  id: "release.review.start",
  on: [{ eventType: "release.review.requested" }],
  async handle(event, context) {
    // Only stored requests start a Goal, so its turns trace back to an Event.
    if (!event.durable) return;
    const { brief } = event.data as { brief: string };
    const input: RunGoalInput = {
      // The writer drafts. The thread is created on first use, then reused.
      target: {
        thread: { externalId: "release-review" },
        participant: { externalId: "editor", participantType: "human" },
        recipient: "writer",
      },
      // The reviewer receives each draft in its own thread.
      lead: {
        thread: { externalId: "release-review-lead" },
        participant: { externalId: "relay", participantType: "human" },
        recipient: "reviewer",
      },
      content: brief,
      policy: "review",
    };
    // A stable key for this call within the delivery lets ordinary Action
    // replay restore a recorded terminal outcome. It does not resume a
    // partially executed Goal; see Retries and identity below.
    const result = await context.actions.runGoal(input, {
      operationKey: "run-review",
    });
    // `status` is the Goal outcome. A completed Action can still report
    // "failed" or "stopped"; this demonstration prints it either way and
    // exits normally. An application would act on it.
    console.log(
      `goal ${result.status} after ${result.turns} target turns:`,
      result.reason ?? "",
    );
  },
});

// Late binding: the adapter needs the app's `send`, but the app does not
// exist yet. The closure reads `app` only when a Goal runs, after creation.
// This direct adapter supports a new loop; it does not replay prior turns.
let app: CopilotzApplication | undefined;
const conversation: GoalConversationAdapter = {
  send(input) {
    if (!app) throw new Error("Application is not ready.");
    return app.send(input);
  },
};

app = await createCopilotz({
  namespace: "release-review",
  plugins: [
    corePlugin,
    // Packages the review Processor beside Core.
    definePlugin({
      id: "@release/review",
      version: "1.0.0",
      processors: { startReview },
    }),
  ],
  resources: {
    agents: {
      writer: agent("writer", "Write concise release notes."),
      reviewer: agent("reviewer", "Review release notes critically."),
    },
    llmConnections: { scripted: { adapter: "scripted" } },
    // Merges next to Core's `default` policy.
    goals: { review: reviewPolicy },
  },
  adapters: {
    llm: { scripted: scriptedModel },
    conversation: { default: conversation },
  },
});

// Prints each completed Goal turn from the Action's progress Events.
async function printProgress(outputs: ReadableStream<ApplicationOutput>) {
  for await (const output of outputs) {
    // Streamed model text is not needed here; cancel it so it can't block.
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      continue;
    }
    if (output.durable && output.type === "copilotz.core.goal.run.progress") {
      const { progress } = output.data as ActionProgressData<
        RunGoalInput,
        { type: "goal.turn.completed"; turn: GoalTurn }
      >;
      console.log(
        `turn ${progress.turn.turn} ${progress.turn.phase}`,
        `message=${progress.turn.outputMessageId}`,
      );
    }
  }
}

try {
  const handle = await app.send({
    type: "release.review.requested",
    payload: { brief: "Draft notes for 1.2: faster search." },
  });
  // Drain outputs and wait for settlement together, then surface a failure
  // only after both sides have finished.
  const [drained, done] = await Promise.allSettled([
    printProgress(handle.outputs),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (done.status === "rejected") throw done.reason;
} finally {
  await app.close();
}
```

Late binding breaks the startup loop: the adapter must exist when the
application is created, but its `send` needs the application. The adapter object
stays unchanged at run time. Only the closure's `app` variable is filled in, so
every turn goes to the same application, namespace and database as the caller.

### Check it works

Run `deno run -A goal-review.ts`, or `node goal-review.ts` on Node 24+. The
output contains three progress lines, `turn 1 target …`, `turn 1 lead …` and
`turn 2 target …`, and a result line:
`goal completed after 2 target turns: Fixture completed after two target turns.`
The result line can appear before every queued progress line has been printed.
The outer `done` waits for the Processor and therefore for its nested foreground
turns. It does not cover detached background work such as Memory consolidation.

Each turn is an ordinary nested operation run by the same application's workers
while the outer delivery waits. If you cap worker concurrency, leave room for
that nested work, or the outer delivery can wait on turns that never start.

## Reference

### Inputs and policy

| Field            | Meaning                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`, `lead` | `GoalScope`: `thread` (object with `id` or `externalId` to create or reuse; a string ID must already exist), `participant` (object or existing ID), one configured Agent `recipient`, optional `metadata` and `visibility`. |
| `content`        | First target input, in the same form a Core message accepts.                                                                                                                                                                |
| `policy`         | Key in `resources.goals`. Defaults to `"default"`.                                                                                                                                                                          |
| `maxTurns`       | Integer from 1 to 1000. It **replaces** the policy value for this call. It is not capped by the policy.                                                                                                                     |

`GoalPolicy.decide` receives `{ id, turn, targetReply, transcript }`. It has no
Action context or content resolver. `GoalTurn.content` is a `ContentSequence` of
references, not inline text, so a policy that judges text must use data it can
reach itself. Without `decide`, the loop runs until the limit and returns
`status: "stopped"` with a "Maximum turns reached" reason.

### Outcomes and failures

- The Action output is a `GoalResult`: `id` (the Action run ID), `status`,
  optional `reason`, `turns` (target turns), optional `finalMessageId`,
  `transcript` and `metrics`.
- `decide` returning `failed` is a **normal completed Action** whose result says
  `status: "failed"`. Check the result's status, not just the Action's.
- Adapter, provider or turn errors (for example a turn that settles without a
  final Agent Message) throw and fail the Action through the ordinary lifecycle.
  Cancelling the Action cancels the active turn's send.
- Goal progress is `<actionId>.progress`, here
  `copilotz.core.goal.run.progress`, with `data.progress.type` set to
  `goal.turn.completed`. There is no standalone Goal Event, handle or stream.

### Retries and identity

Every turn is sent with the deduplication ID `<actionRunId>:<turn>:<phase>`.
Ordinary Action replay restores a recorded terminal outcome without executing
the Goal loop again.

A Goal has no durable cursor or built-in resume for a partially executed loop.
If execution re-enters before a terminal Action outcome was recorded, it starts
from the first turn with the same deduplication IDs. The direct `app.send`
Adapter above creates a fresh correlation ID and observes live outputs; it does
not retrieve previous turn results, and repeat admission can fail with a
deduplication conflict. Stable deduplication IDs alone do not make the loop
resumable.

If partial-run recovery is required, the host-supplied conversation Adapter must
reconcile previous admissions and provide their recorded turn outputs. Keep
`decide` deterministic over those replies as well; the example above does not
implement that recovery behavior.

### Authorization and provenance

The Goal sends as whatever `participant` you pass. Neither Agent gets a Tool or
grant from it. The host decides who may start a Goal, and that the caller may
act in **both** scopes and relay content between them. A Goal is not a generic
Event delivery status, and it does not establish a trusted actor or Space
relations. Apply your own authorization before the call, as you would for any
Core message ingress.

## What this unlocks

- Writer/reviewer, planner/critic or simulated-user test loops with a hard bound
  and an explicit outcome.
- Goals started from any Event, schedule or HTTP-exposed Action through an
  ordinary typed caller.
- Retry-safe iteration, because each turn is an identified, deduplicated send.

## Next steps

- [Collaborate with specialists](./getting-started/part-3-add-agent-behavior/12-collaborate-with-specialists.md):
  Agent-to-Agent Ask within a single turn.
- [Actions](./actions.md): callers, operation keys, progress and failure.
- [Models](./models.md): connections and custom LLM Adapters.
- [Testing and inspection](./testing-and-inspection.md): scripted providers in
  focused tests.
