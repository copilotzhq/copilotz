# Goal Action

Core exposes `runGoalAction` (Action alias `runGoal`) and a default
`resources.goals.default` policy. Invoke it through the ordinary Action context:

```ts
await context.actions.runGoal({
  target: {
    thread: "target-thread",
    participant: "requester",
    recipient: "target",
  },
  lead: { thread: "lead-thread", participant: "proxy", recipient: "lead" },
  content: "Complete the task.",
  policy: "default",
});
```

The host supplies `adapters.conversation.default`, implementing `send` with the
normal application send/settlement contract. It can supply an existing
application's send capability directly; Core creates no nested application. Bind
it before invoking the Action. A policy can select another Adapter alias. The
application remains responsible for authorizing the caller's thread scopes.

Override `resources.goals.default` with `{ maxTurns, adapter?, decide? }` in the
final composition. `decide` receives the target reply and a snapshot of the
transcript, returning `continue` or a completed/failed/stopped outcome. There is
no configuration factory. The default maximum is 20 turns; inputs may choose an
explicit bound from 1 through 1,000.

Each turn waits for the selected conversation Adapter's settled send, including
Tool continuations, and forwards canonical content to the next participant.
Stable Action-run/turn/phase deduplication keys prevent a retried Action from
creating duplicate turn ingress. Goal turn summaries use normal Action progress
Events; the final result is the Action output. Errors and cancellation use the
normal Action lifecycle, and cancellation cancels the active conversation send.

There is no separate Goal handle, event stream, scheduler or workflow engine.
The loop does not add an independent durable goal cursor. On an Action retry it
re-observes deduplicated turns; application policy hooks should be deterministic
for those recorded replies. No old `runGoal(application, options)` wrapper
remains.
