---
title: "Subscriptions"
description: "Authorized Collection snapshots, owner-pushed deltas, applied checkpoints and optimistic settlement."
section: Reference
order: 21
status: experimental
---

# Subscriptions

A subscription is an authorized Collection read. The owner sends a complete
snapshot at sequence S, then ordered change batches covering `(from, to]`.
Filtering can produce an empty batch: it still advances coverage. Writes are
published after commit; ordinary commits perform no subscriber SQL reads.

Server adapters use the existing read service:

```ts
const subscription = await context.read.observe("note", {
  where: { archived: false },
  limit: 50,
});
for await (const frame of subscription.frames) {
  // Send through the device channel's bounded output gate.
  await send(frame);
}
subscription.detach();
```

Applications expose the same read as
`app.collections.note.observe(query, { authority, checkpoint, signal })`.
Authority must be a retained credential identity admitted by the host; worker
attempt and alarm-occurrence authority cannot open device subscriptions. An
existing invocation supplies its retained authority automatically. Namespace and
database scope must match it. Subscription reads use the Collection's registered
F4 policy, including declared permission sources and credential lifetime.

The SDK's `client.collections.observe(name, query, options)` returns a live
handle. Supply its authenticated `device` transport when constructing the
client. This branch contains the in-process contract; the WebSocket device
binding is not yet present. No HTTP polling fallback is provided.

```ts
const client = createCopilotzClient({ baseUrl: "/api", device });
const notes = client.collections.observe("note", { limit: 50 }, {
  onChange(rows) {
    renderNotesView(rows);
  },
});
const receipt = await client.actions.submit("notes.save", input, {
  idempotencyKey: crypto.randomUUID(),
});
notes.optimistic(
  receipt.operationId,
  input,
  client.operations.result(receipt.operationId),
);
// On view teardown:
notes.close();
```

`rows`, `deltas`, `sequence` and `checkpoint` describe applied state. `onChange`
receives the proposed state; if it throws, the handle detaches and preserves the
previous applied checkpoint. `optimisticLayers` retains each layer until the
subscription applies through its operation result's `seq`, or the operation
fails. A replacement snapshot also settles covered layers. Action `invoke`
continues returning the Action's value; `operations.result` returns
`{ value, seq }`.

After clean EOF, `await handle.reconnect()` resumes from that handle's applied
checkpoint. Persist rows, sequence and checkpoint together to restore a new
handle using `options.initial`. A checkpoint alone cannot reconstruct a view.
Transport failure retries are bounded; a view may implement its own supervisor.

Permission notices fence queued data immediately. Revocation emits `revoked` and
ends the channel. Changed constraints emit a `scope` reset; reconnect takes a
new snapshot and refills the limited selection. Retention loss, owner takeover,
credential expiry and schema/scope changes reset rather than join different
snapshots. The SDK processes resets with a fresh snapshot.

Queries currently support Collection filters, conjunctive `all`, `limit`
(1–1000), and ascending or descending `id` order. Cursors, includes, text search
and other ordering fields are refused. Each owner retains at most 32 observed
Collection caches, each limited to 10,000 rows and 16 MiB, and 256
subscriptions. Each reader and replay history is limited to 64 frames / 1 MiB.
Detached history expires after five minutes. Exceeding a reader buffer emits
`reset: slow_consumer`; other readers continue. A complete snapshot must fit the
logical buffer bound.
