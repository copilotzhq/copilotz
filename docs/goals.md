# Goal Runner

`runGoal` is a local authoring helper for alternating complete Agent turns
between a target and a lead. It builds on `application.send()`; it is not a
plugin, Resource, Collection, Action, or Processor.

```ts
import { runGoal } from "@copilotz/copilotz/goals";

const goal = runGoal(app, {
  id: "booking-check",
  target: {
    thread: "booking-thread",
    participant: "simulated-user",
    recipient: "booking-agent",
  },
  lead: {
    thread: "lead-thread",
    participant: "target-proxy",
    recipient: "lead-agent",
  },
  content: "I need to book a bus ticket.",
  maxTurns: 8,
  decide({ targetReply }) {
    return targetReply.content.some((part) =>
        part.type === "text" && part.text.includes("confirmed")
      )
      ? { status: "completed", reason: "booking-confirmed" }
      : "continue";
  },
});

const result = await goal.done;
```

The target and lead Threads and their participants must already exist. Each
phase is one ordinary Core Message sent to exactly one recipient:

1. Send to the target and await `send().done`.
2. Select its final canonical `message.created` output.
3. Pass the exact ContentSequence—including Asset refs—to the lead.
4. Pass the lead's final Message back to the target.

`send().done` is the turn barrier, so Tool pipelines, parallel Tools, nested
Asks, retries, and final Message projection settle before the other Agent gets a
turn. `handle.events` exposes only Goal turn/finish summaries; `onOutput`
receives the underlying resolved Events and progressive streams when live UI is
needed.

Messages, content, and Action lifecycles are already durable and remain
inspectable after restart. The small controller itself is deliberately local: it
does not automatically resume a partially completed Goal after process loss.
That avoids duplicating Core's durable conversation workflow. A future exact
auto-resume requirement would need a narrow durable manifest for controller
decisions, not a second transcript state machine.
