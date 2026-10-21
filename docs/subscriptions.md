---
title: "Subscriptions"
description: "Authorized Collection snapshots, owner-pushed deltas, applied checkpoints and optimistic settlement."
section: Reference
order: 21
status: experimental
---

# Subscriptions

A subscription is an authorized Collection read. The owner sends a complete
snapshot at namespace-local sequence S, then ordered change batches covering
`(from, to]`. Filtering can produce an empty batch for a policy-visible mutation
outside the selected window. A mutation invisible to the policy in both its old
and new record emits no frame. Other namespaces emit no progress.
Namespace-local event counts also back Action result sequences, preserving
optimistic settlement. Writes are published after commit; ordinary commits
perform no subscriber SQL reads. Predicates and their constants are compiled at
admission. Each state maintains ordered matching IDs and evaluates only changed
records on commit; window exits refill from that index.

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
const receipt = await client.actions.submit("saveNote", input, {
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

Live queries accept scalar `filter` predicates, scalar `where` on declared
scalar fields (plus `id`), conjunctive `all`, `limit` (1–1000), and ascending or
descending `id` order. String ranges use SQL `COLLATE "C"` and Unicode
code-point ordering in memory. `eqIgnoreCase`, `inIgnoreCase`, `jsonEquals`,
JSON containment (`contains`/`containsAny`), timestamp predicates, cursors,
includes, text search, and other ordering fields are refused. These restrictions
apply to policy filters as well as client queries. Use typed scalar predicates
for complex data.

Configure owner limits through `engine.subscriptionLimits`:

| Option                                                                    |         Default |
| ------------------------------------------------------------------------- | --------------: |
| `maxStates` (attached states across the schema)                           |             256 |
| `maxStatesPerPrincipal` (tenant and principal, across sockets/namespaces) |              32 |
| `maxDetachedPerPrincipal`                                                 |              16 |
| `maxPredicateNodes` (per query/policy filter group)                       |              64 |
| `maxPredicateValues` (`in`/`overlaps` list length)                        |              32 |
| `maxQueryBytes` (serialized filter group)                                 |          16 KiB |
| `maxPendingAdmissions`                                                    |             256 |
| `maxCollections`                                                          |              32 |
| `maxRows` / `maxCacheBytes` (per row cache)                               | 10,000 / 16 MiB |
| `maxFrames` / `maxBytes` (reader and replay history)                      |      64 / 1 MiB |
| `retentionMs`                                                             |         300,000 |

All limits must be positive safe integers; SQL predicate structural bounds still
apply when raising live limits. Detached states do not consume active admission.
Retention is bounded per principal, and capacity pressure evicts the oldest
detached state first. Evicted checkpoints require a fresh snapshot.

`subscription_query_refused` identifies an unsupported or oversized live query
or policy. `subscription_capacity_exceeded` identifies owner, principal, socket,
or Collection admission limits. Both are non-retryable on the device protocol;
change the query or release capacity before retrying. A slow reader receives
`reset: slow_consumer`; other readers continue. A snapshot must fit `maxBytes`.

The facade's `deviceLimits` (also accepted by `createServerFacadeFetchHandler`)
sets `maxSubscriptions` (16), `maxPendingControls` (256), and `maxPendingBytes`
(1 MiB). Set `createDeviceTransport({ maxSubscriptions })` to the matching limit
when raising the server default. Only a single `hello` is accepted before
authentication; wait for `welcome` before other controls, including after
reauthentication. The SDK does this automatically.

Device upgrades require a matching Origin: the request's origin or an explicit
canonical HTTP(S) origin in `allowedOrigins`. This option is accepted by
`defineServerFacade` and by `createServerFacadeFetchHandler`. Foreign or opaque
origins are refused with HTTP 403 before native upgrade, on Deno and Node.
Without Origin, cookie headers are discarded and cookie credentials are refused;
non-browser clients must use nonempty `authorization` or `x-api-key`
credentials. Host authentication must use the supplied request, not ambient
cookie state.

For same-origin browser cookie authentication use
`credentials: () => ({ cookie: true })`. This explicitly selects the cookie
captured at upgrade without exposing an HttpOnly cookie to JavaScript. Empty
credentials are refused. Cross-origin cookie clients must be explicitly allowed.
The default Action-session cookie is `__Host-copilotz_session` (Secure, Path=/,
HttpOnly, no Domain). More than one cookie with the configured name is refused.

The browser runtime takes this same `device` as `live`. Client Collection
`get(id, options)` and `list(query, options)`, `observe(read)`, Action proxies
and View `ctx` retain their APIs. Reads initially return `loading`, then notify
their tracked Views when owner frames apply. Optimistic commands are projected
over SDK-owned layers; only the SDK decides when each read has covered the
Action sequence. `ActionTransport` accepts decimal-string sequences as well as
safe integers. Content selections are forwarded and resolved using the existing
Collection content reader, with its declared fields and byte budget. A window
defers bodies over its budget instead of failing (`overflow: "defer"` unless the
subscriber asks to reject; see [Content and assets](./content-assets.md)).

For query invalidation without records, use
`client.collections.observe(name, {}, {progressOnly:true})`. This is the same
subscription protocol and state machine: snapshots and deltas have empty rows,
and `collectionChanged` is emitted only when the policy matches the old or new
record. The owner performs no Collection row scan; normal read authorization,
permission notices, checkpoint resume and revocation still apply. Row
query/content options cannot be combined with progressOnly, and a progress
cursor cannot resume a row selection. `/web` uses this mode for query-Action
dependencies.
