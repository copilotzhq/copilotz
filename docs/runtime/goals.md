---
title: Goals
description: Goals run bounded multi-turn journeys using normal Copilotz runs plus stop and evaluate callbacks.
section: Runtime
order: 20
status: stable
---

# Goals

`copilotz.goal(...)` owns a loop.

It uses normal `run` calls internally, but adds:

- a sender with `usingAgent`
- a target agent
- a private lead thread
- `maxTurns`
- a `stop` callback
- an `evaluate` callback
- final result metrics and assessments

## Mental Model

A goal has two surfaces:

- the target thread, where the user-like sender talks to the target agent
- the private lead thread, where `sender.usingAgent` decides the next sender
  message

On each turn:

1. the current sender message is sent to the target agent
2. the target agent's final message is collected
3. `stop` can end the loop
4. if the loop continues, the final target text is sent to the lead agent
5. the lead response becomes the next sender message

## Events

Goal emits normal internal run events with metadata:

```ts
{
  goalId: "...",
  goalTurn: 3,
  goalPhase: "target" | "lead" | "judge",
}
```

It also emits:

- `GOAL_STOPPED`
- `GOAL_RESULT`

## Evaluation

`evaluate` runs after the loop stops. It can return one assessment or many.

It can also call `context.run(...)` to use a judge agent. Those judge events are
marked with `goalPhase: "judge"`.

## Related Pages

- [Run Synthetic QA with Goals](../build-guides/synthetic-qa-with-goals.md)
- [Goal API](../reference/goal-api.md)
