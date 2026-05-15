---
title: Goal API
description: Options, callbacks, events, and result shape for copilotz.goal.
section: Reference
order: 30
status: stable
---

# Goal API

```ts
const handle = await copilotz.goal(options);
```

`GoalOptions` extends the normal message payload and run options, but `sender`
must include `usingAgent`.

## Sender

```ts
sender: {
  id: "client-01",
  type: "user",
  name: "Tiago",
  usingAgent: "qa-direct-buyer",
}
```

`usingAgent` can be an agent id/name already registered on the instance or an
inline agent definition.

## Loop Options

```ts
{
  maxTurns?: number;
  stop?: GoalStopCallback;
  evaluate?: GoalEvaluateCallback;
}
```

## Stop Callback

```ts
stop: (({ turns, transcript, lastMessage }) => {
  if (lastMessage?.content.includes("[GOAL_COMPLETED]")) {
    return { stop: true, status: "completed", reason: "done" };
  }
  return false;
});
```

## Evaluate Callback

```ts
evaluate: (({ transcript }) => ({
  name: "completion",
  status: transcript.some((message) => message.content.includes("pix"))
    ? "completed"
    : "failed",
}));
```

## Events

Goal streams internal run events plus:

- `GOAL_STOPPED`
- `GOAL_RESULT`

Internal events are annotated with `goalId`, `goalTurn`, and `goalPhase`.

## Result

The final result includes:

- `status`
- `score`
- `report`
- `reason`
- `threadId`
- `leadThreadId`
- `turns`
- `transcript`
- `events`
- `assessments`
- `metrics`

## Related Pages

- [Goals](../runtime/goals.md)
- [Run Synthetic QA with Goals](../build-guides/synthetic-qa-with-goals.md)
