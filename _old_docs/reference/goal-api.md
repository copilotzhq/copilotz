# Goal API

`copilotz.goal(...)` runs a multi-turn goal loop using the same message and run
options as `copilotz.run(...)`, plus loop control and evaluation callbacks.

```typescript
const handle = await copilotz.goal(options);
```

## Signature

```typescript
goal(options: GoalOptions): Promise<GoalHandle>
```

## GoalOptions

`GoalOptions` extends the normal message payload and run options. The sender is
special because it must include `usingAgent`.

```typescript
type GoalOptions =
  & Omit<MessagePayload, "sender">
  & RunOptions
  & {
    sender: GoalSender;
    maxTurns?: number;
    stop?: GoalStopCallback;
    evaluate?: GoalEvaluateCallback;
  };
```

### GoalSender

```typescript
type GoalSender = NonNullable<MessagePayload["sender"]> & {
  usingAgent: string | Agent;
};
```

`usingAgent` can be an agent id/name already configured on the Copilotz instance
or an inline `Agent` definition.

From the target thread's point of view, `sender` is still a normal user sender.
`usingAgent` is stripped before the target `run()` and used only in the private
lead thread.

### Required Routing

A goal needs a target agent. Provide either:

```typescript
target: "agent-id";
```

or a thread participant:

```typescript
thread: {
  participants: ["agent-id"],
}
```

Explicit `target` is recommended.

## GoalHandle

```typescript
interface GoalHandle {
  id: string;
  threadId: string;
  leadThreadId: string;
  status: "running";
  events: AsyncIterable<GoalStreamEvent>;
  done: Promise<GoalResult>;
  cancel: () => void;
}
```

- `events` streams all target, lead, and judge run events, plus goal lifecycle
  events.
- `done` resolves with the final `GoalResult`.
- `cancel()` requests cancellation and cancels active internal run handles.

## GoalStreamEvent

```typescript
type GoalStreamEvent = StreamEvent | GoalStoppedEvent | GoalResultEvent;
```

Goal-specific event types:

```typescript
interface GoalStoppedEvent {
  type: "GOAL_STOPPED";
  payload: {
    goalId: string;
    threadId: string;
    leadThreadId?: string;
    turn: number;
    status: GoalStatus;
    reason?: string;
  };
}

interface GoalResultEvent {
  type: "GOAL_RESULT";
  payload: GoalResult;
}
```

Internal `run()` events are emitted unchanged except for metadata annotations:

```typescript
{
  goalId: string;
  goalTurn: number;
  goalPhase: "target" | "lead" | "judge";
}
```

## GoalResult

```typescript
interface GoalResult {
  id: string;
  status: GoalStatus;
  score?: number;
  report?: string;
  reason?: string;
  threadId: string;
  leadThreadId?: string;
  turns: number;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  assessments: GoalAssessment[];
  metrics: {
    durationMs: number;
    targetRuns: number;
    leadRuns: number;
    judgeRuns: number;
    messages: number;
    toolCalls: number;
    errors: number;
  };
}
```

### GoalStatus

```typescript
type GoalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "error";
```

## Transcript

```typescript
interface GoalTranscriptMessage {
  turn: number;
  phase: "target" | "lead" | "judge";
  senderId?: string | null;
  senderName?: string | null;
  senderType?: string | null;
  content: string;
}
```

The transcript includes messages observed across the goal phases. Public status
endpoints should usually filter this transcript to target-thread user and agent
messages only.

## Stop Callback

`stop` runs after each target agent final message.

```typescript
type GoalStopCallback = (
  context: GoalStopContext,
) => boolean | GoalStopResult | Promise<boolean | GoalStopResult>;
```

```typescript
interface GoalStopContext {
  id: string;
  turns: number;
  threadId: string;
  leadThreadId?: string;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  lastMessage?: GoalTranscriptMessage;
}

interface GoalStopResult {
  stop: boolean;
  status?: GoalStatus;
  reason?: string;
}
```

Returning `true` is equivalent to `{ stop: true }`.

Use a structured result when you need a specific status or reason:

```typescript
stop: (({ lastMessage }) => {
  if (lastMessage?.content.includes("payment link")) {
    return {
      stop: true,
      status: "completed",
      reason: "payment link generated",
    };
  }
  return false;
});
```

## Evaluate Callback

`evaluate` runs after the goal loop stops.

```typescript
type GoalEvaluateCallback = (
  context: GoalEvaluateContext,
) =>
  | GoalAssessment
  | GoalAssessment[]
  | undefined
  | Promise<GoalAssessment | GoalAssessment[] | undefined>;
```

```typescript
interface GoalEvaluateContext {
  id: string;
  threadId: string;
  leadThreadId?: string;
  turns: number;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  run: (
    message: MessagePayload,
    options?: RunOptions,
  ) => Promise<GoalRunResult>;
}
```

`context.run(...)` is a normal Copilotz run helper for evaluation activity. Use
it to call a judge agent, generate a report, or run a final analysis. Events
from this helper are emitted with `goalPhase: "judge"`.

```typescript
evaluate: (async ({ run, transcript }) => {
  const judge = await run({
    content: JSON.stringify(transcript),
    sender: { id: "goal", type: "system", name: "Goal" },
    target: "judge",
    thread: {
      externalId: "goal-judge-thread",
      participants: ["judge"],
    },
  });

  return {
    name: "judge",
    status: judge.text.includes("PASS") ? "completed" : "failed",
    report: judge.text,
  };
});
```

## Assessments

```typescript
interface GoalAssessment {
  name?: string;
  status: "completed" | "failed" | "warning";
  score?: number;
  report?: string;
  metadata?: Record<string, unknown>;
}
```

If any assessment has `status: "failed"`, the final result status becomes
`"failed"`. If assessments include scores, the result score is their average.
Reports are joined with blank lines.

## Tool Result Privacy

The private lead thread receives only the target agent's final text response for
each turn. It does not receive target tool result messages by default.

Tool result events can still appear in:

- `handle.events`
- `GoalResult.events`
- metrics such as `toolCalls`

This is intentional. It preserves realistic user simulation while keeping
diagnostic data available to trusted callers.

## Example: Synthetic QA

```typescript
const handle = await copilotz.goal({
  content:
    "Ola, quero comprar uma passagem de Sao Paulo para Peruibe no dia 27/06/2026.",
  sender: {
    id: "client-01",
    type: "user",
    name: "Tiago",
    usingAgent: {
      id: "qa-direct-buyer",
      name: "QA Direct Buyer",
      role: "Simulated customer",
      instructions: "Respond as Tiago. End with [GOAL_COMPLETED] after PIX.",
      llmOptions: { provider: "gemini", model: "gemini-2.5-flash" },
    },
  },
  target: "mobizap",
  thread: {
    externalId: "qa-client-01",
    participants: ["mobizap"],
  },
  maxTurns: 30,
  stop: ({ lastMessage }) =>
    lastMessage?.content.includes("[GOAL_COMPLETED]")
      ? { stop: true, status: "completed" }
      : false,
});

const result = await handle.done;
```

## Related Pages

- [Goals Runtime Guide](../runtime/goals.md)
- [Thread and Message APIs](./thread-and-message-apis.md)
- [Feature Handler Contract](./feature-handler-contract.md)
