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
client. One device transport multiplexes the SDK and browser runtime's live
reads over an authenticated WebSocket, with no polling fallback.

```ts
import { createDeviceTransport } from "@copilotz/copilotz/client";

const device = createDeviceTransport({
  url: "wss://app.example/api/device",
  credentials: () => ({ authorization: `Bearer ${sessionProof}` }),
});
// After an HTTP session change: await device.reauthenticate();
// On device teardown: device.close();
```

Compose the server facade as usual, then use the public hosting adapter. Both
Deno and Node mount `/api/device` automatically (or `<basePath>/device` when the
facade sets `basePath`), alongside HTTP routes and worker sockets:

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { listen } from "@copilotz/copilotz/adapters/deno";
// Node: import { listen } from "@copilotz/copilotz/adapters/node";

const app = await createCopilotz({
  // Your plugins, resources.server.default, authorization and database options.
});
const listener = await listen(app, { port: 8000 });
// await app.close() closes its listeners too.
```

For a custom Fetch host, both embedded and gateway factory options accept
`upgradeDevice`. It takes the original Request and returns `socket`, `response`
and an optional `requestDeadline` (epoch milliseconds):

```ts
const app = await createCopilotz({
  // Your server facade and application options.
  upgradeDevice: (request) => ({
    ...Deno.upgradeWebSocket(request),
    requestDeadline: Date.now() + 60_000,
  }),
});
Deno.serve(app.fetch);
```

An explicit upgrade takes precedence over the adapter default and must suit the
native host. The existing facade still owns session authentication, Collection
exposure, admission and revocation. The binding renews one second before a
supplied request deadline. Deno completes recovery admission before upgrading.
With Oxian 0.22's synchronous Node upgrade decision, the native handshake can
complete first; device messages remain bounded and held until recovery admission
succeeds. Worker paths remain reserved for worker admission; configure them
separately from `/api/device`.

An open socket reauthenticates explicitly; changing an HTTP cookie alone does
not change a channel's authority. Each channel renews after five minutes, fences
late output by generation and resumes from its applied checkpoint.
Fifteen-second heartbeats expose channel heads and repair a lost final push.
Transport buffers and logical fragment reassembly are bounded.

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

`status`, `rows`, `deltas`, `sequence` and `checkpoint` describe applied state.
`onState` notifies after application and optimistic-layer changes. `onChange`
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
clears retained client rows and ends the channel. Changed constraints emit a
`scope` reset; reconnect takes a new snapshot and refills the limited selection.
Retention loss, owner takeover, credential expiry and schema/scope changes reset
rather than join different snapshots. The SDK processes resets with a fresh
snapshot.

Queries currently support Collection filters, conjunctive `all`, `limit`
(1–1000), and ascending or descending `id` order. Cursors, includes, text search
and other ordering fields are refused. Each owner retains at most 32 observed
Collection caches, each limited to 10,000 rows and 16 MiB, and 256
subscriptions. Each reader and replay history is limited to 64 frames / 1 MiB.
Detached history expires after five minutes. Exceeding a reader buffer emits
`reset: slow_consumer`; other readers continue. A complete snapshot must fit the
logical buffer bound.

The browser runtime takes this same `device` as `live`. Client Collection
`get(id, options)` and `list(query, options)`, `observe(read)`, Action proxies
and View `ctx` retain their APIs. Reads initially return `loading`, then notify
their tracked Views when owner frames apply. Optimistic commands are projected
over SDK-owned layers; only the SDK decides when each read has covered the
Action sequence. `ActionTransport` accepts decimal-string sequences as well as
safe integers. Content selections are forwarded and resolved using the existing
Collection content reader, with its declared fields and byte budget.

For query invalidation without records, use
`client.collections.observe(name, {}, {progressOnly:true})`. This is the same
subscription protocol and state machine: snapshots and deltas have empty rows,
while `collectionChanged` distinguishes mutations from unrelated owner progress.
The owner performs no Collection row scan; normal read authorization, permission
notices, checkpoint resume and revocation still apply. Row query/content options
cannot be combined with progressOnly, and a progress cursor cannot resume a row
selection. `/web` uses this mode for query-Action dependencies.
