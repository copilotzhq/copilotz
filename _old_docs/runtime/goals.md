# Goals

`copilotz.goal(...)` runs a bounded conversation where one agent-like sender
tries to move another agent toward a defined outcome.

It is useful for:

- AI QA and agent evaluation
- synthetic user journeys
- workflow rehearsals
- autonomous background jobs that need a final result

A goal is built from the same primitives as `copilotz.run(...)`: messages,
threads, participants, agents, tools, events, and callbacks. The difference is
that `goal` owns the loop.

## Mental Model

A goal has two conversation surfaces:

- the target thread, where the tested or working agent talks to a user-like
  sender
- a private lead thread, where `sender.usingAgent` decides the next user message

On each turn:

1. Copilotz sends the current user message to the target agent with `run()`.
2. Copilotz waits for the target agent's final `NEW_MESSAGE`.
3. The `stop` callback can end the goal.
4. If the goal continues, Copilotz sends only the target agent's final text to
   the private lead agent.
5. The lead agent's response becomes the next user message in the target thread.

The loop stops when `stop` returns `true`, `maxTurns` is reached, the goal is
cancelled, or an execution error occurs. After the loop, `evaluate` may produce
one or more assessments.

## Basic Example

```typescript
const leadAgent = {
  id: "qa-direct-buyer",
  name: "QA Direct Buyer",
  role: "Simulated customer",
  instructions: `
You are Tiago. You want to buy one bus ticket.
Answer only with the text the customer would type.
When the agent provides a payment link or PIX code, thank them and end with:
[GOAL_COMPLETED]
  `.trim(),
  llmOptions: { provider: "gemini", model: "gemini-2.5-flash" },
};

const handle = await copilotz.goal({
  content:
    "Ola, quero comprar uma passagem de Sao Paulo para Peruibe no dia 27/06/2026.",
  sender: {
    id: "client-01",
    type: "user",
    name: "Tiago",
    usingAgent: leadAgent,
  },
  target: "mobizap",
  thread: {
    externalId: "goal-client-01",
    participants: ["mobizap"],
  },
  maxTurns: 30,
  stop: ({ lastMessage }) => {
    const text = lastMessage?.content ?? "";
    if (text.includes("[ERRO_CRITICO]")) {
      return { stop: true, status: "failed", reason: text };
    }
    if (text.includes("[GOAL_COMPLETED]") || text.includes("pix")) {
      return {
        stop: true,
        status: "completed",
        reason: "payment signal reached",
      };
    }
    return false;
  },
  evaluate: ({ transcript }) => ({
    name: "booking-completion",
    status: transcript.some((message) => message.content.includes("pix"))
      ? "completed"
      : "failed",
    score: transcript.some((message) => message.content.includes("pix"))
      ? 1
      : 0,
  }),
});

for await (const event of handle.events) {
  if (event.type === "NEW_MESSAGE") {
    console.log(event.payload);
  }
}

const result = await handle.done;
console.log(result.status, result.score, result.report);
```

## Sender And Lead Agent

The `sender` is still a normal message sender from the target thread's point of
view. It should usually be `type: "user"`.

`sender.usingAgent` is the lead agent used privately to generate the next sender
message. It can be:

- an agent id or name already registered in the Copilotz instance
- an inline `Agent` definition generated at runtime

```typescript
sender: {
  id: "goal-lead",
  type: "user",
  name: "Goal Lead",
  usingAgent: {
    id: "qa-customer",
    name: "QA Customer",
    role: "Simulated customer",
    instructions: "...",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  },
}
```

This makes dynamic personas natural without changing the target agent
configuration.

## Tool Result Visibility

The lead agent does not see raw target tool results by default.

The lead receives only the final user-facing text produced by the target agent
on that turn. Tool result events are still part of the outer goal event stream
and final `GoalResult.events` for audit, metrics, and debugging, but they are
not inserted into the private lead thread as context.

This keeps the simulation realistic: a synthetic customer sees what a real user
would see, not private tool payloads.

If the target agent summarizes tool output in its own response, the lead can see
that summary because it is part of the user-facing message.

## Events

`goal` reuses the normal `run()` event stream for each internal run and adds two
goal-specific events:

- `GOAL_STOPPED`: emitted once the loop has stopped
- `GOAL_RESULT`: emitted with the final `GoalResult`

All events produced by internal runs are annotated with metadata:

```typescript
{
  goalId: "...",
  goalTurn: 3,
  goalPhase: "target" | "lead" | "judge"
}
```

This lets callers stream live progress while still distinguishing target,
private lead, and evaluation activity.

## Stop Versus Evaluate

Use `stop` for loop control.

Examples:

- payment link generated
- max business-specific turn count reached
- repeated prompt loop detected
- fatal domain error detected

Use `evaluate` for final assessment.

Examples:

- deterministic transcript checks
- score aggregation
- calling a judge agent through `context.run(...)`
- generating a report artifact

`evaluate` runs after the loop stops. It can return no assessment, one
assessment, or multiple assessments.

## Running From Endpoints Or Jobs

`goal` returns a live handle, so endpoint handlers can choose one of two
patterns:

- request-bound streaming: forward `handle.events` to the client
- background run: store a durable record, drain `handle.events` in the
  background, then persist `handle.done`

For production jobs, prefer the durable pattern:

1. Create a collection record with status `running`.
2. Start `copilotz.goal(...)`.
3. Persist public transcript/progress as events arrive.
4. Persist the final `GoalResult`.
5. Expose a status endpoint that reads the collection record.

Keep raw tool result payloads out of public status responses unless the caller
is trusted. They are useful for internal diagnostics but usually not part of the
user-facing transcript.

## When Not To Use Goals

Use `run()` instead when you only need to process one inbound message.

Use `start()` when you want a human-operated terminal loop.

Use a custom feature or processor when the loop is purely deterministic and does
not need an agent lead.

## Related Pages

- [Goal API Reference](../reference/goal-api.md)
- [How Events Work](./how-events-work.md)
- [How Threads Work](./how-threads-work.md)
- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
