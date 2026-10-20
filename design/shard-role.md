# Pinned shard role

## Current implementation

- `runtime/application/gateway.ts:48` binds a dispatcher to owner worker calls
  before recovery. `runtime/execution/remote-admission.ts:54` uses accepted
  sessions, not worker payloads, for placement.
- `runtime/application/worker.ts:50` rejects persistence on workers and runs
  owner capabilities over Oxian 0.22 `callHost`.
- `runtime/application/hosting.ts:25` associates listeners with role lifetime.
- Sandbox `adapters/shard/shard.ts:56` owns a pinned Hypervisor, HTTP dispatch,
  epoch checks and resume admission. `actions/shared/dispatch/index.ts:38`
  duplicates durable effect tracking in a command collection.
- Sandbox `adapters/pool/actions.ts:54` implements HTTP callbacks and
  `authoring/shard-bridge.ts:12` authenticates them separately.

## Target and public API

`createCopilotz({role: "shard", id, transports, admit, ...})` creates a
persistence-free pinned host. Authentication returns an Oxian admission and a
platform principal: trusted worker, computer, actor-bound browser, or scoped
connector. Workload and callback scopes come from admission, never hello data.
Browser placement uses rendezvous hashing of the authenticated actor over the
configured shard IDs. Reordering shard IDs cannot change assignment.

The shard owns dispatch, epoch/session checks at assignment (including queued
work), capacity observation, drain, and its listener. Owner binding supplies
existing worker-call and lifecycle capabilities and returns the accepted session
source consumed by gateway remote admission. Only trusted workers receive the
Copilotz owner capability protocol. Other kinds use explicitly scoped callbacks.

Stateless controllers use a platform HTTP work client/server protocol, with
bounded request metadata, streaming output and explicit terminal framing. A
success response is emitted only after `started`; ambiguous transport loss is
never converted to no-start. There is no automatic redispatch. Host applications
supply controller authentication. Product HTTP dispatch code is deleted.

Shard orchestration callbacks use an authenticated Oxian worker connection to
the owner and `callHost`, with owner admission supplying the shard identity.
Application callbacks invoke ordinary owner Actions; persistence, receipts and
attempt checks remain at the owner. No computer receives a database.

## Guarantees and deletions

- Assignment rechecks the exact accepted session and expected epoch; takeover
  cannot silently retarget old work. Drain stops ingress before draining peers.
- Untrusted browser hello metadata cannot select another actor or shard.
- Connector workloads and callbacks are explicit scopes.
- Capacity includes ready capacity, reservations, queued work and a scale
  signal.
- Sandbox uses Action effects instead of its command collection; uncertainty
  remains indeterminate. Browser grants and workspace lifecycle row CAS remain
  domain authority, not duplicated transport fencing.
- Delete sandbox's dispatch endpoint/client implementation and HTTP owner
  bridge. Keep previews, browser live relay, provider launch and workspace
  policy.

## Validation and risks

Exercise all four kinds, callbacks, scope refusals, stable browser assignment,
queued epoch races, takeover, drain/reconnect and capacity. Run existing owner
receipt and takeover suites. Run sandbox suites including crash, attached,
workspace and browser grants. Run full Copilotz suites with PGlite and Postgres
on port 55433 and record counts. Remote owner/session replication must not claim
synchronous authority from cached network snapshots; local owner binding and
remote application callback connections have different contracts.

## Remote owner composition

A remote gateway supplies
`dispatcher: binding => createShardDispatcher({
shardId, controller, transports, admit, binding })`.
Serve that dispatcher's Hypervisor on an authenticated shard-only WebSocket
endpoint. The pinned shard uses `connectShardDispatcher({shard, worker})` to
dial it. That uplink carries accepted leaf session changes and existing owner
capabilities via `callHost`. The gateway's synchronous session authority is
populated only by its admitted uplink, rejects expired leaf leases, and clears
on uplink replacement/disconnect. Leaf lifecycle retirement is forwarded to the
existing owner capability host. Calls follow ordered session updates and retain
the leaf's exact parent/fence; a worker payload never creates placement
evidence. HTTP dispatch remains a single request with bounded streaming output
and no redispatch.

The remote helper binds one gateway owner to one pinned shard. An app can create
one binding per owned shard; it must route its own schemas and shard addresses.
It does not elect database owners or replace platform owner epochs. Deployment
must authenticate both the controller and the shard uplink.

Sandbox orchestration uses the separate scoped `connectShardOwner` helper and
`shardOwnerCalls` handler; these carry application callbacks, not fabricated
Copilotz delivery authority. Snapshot policy and grants stay at the app owner.

Computer, connector and browser workload hosts use `createShardWorker` from the
shard subpath. It wraps Oxian's worker without importing owner/database modules,
strips the private assignment token before invoking workload handlers, and
preserves strict metadata schemas such as Oxian HTTP. The ordinary Copilotz
worker role uses the same boundary. An assign callback must throw on a scope
mismatch: Oxian's `undefined` selection means default placement, not denial.
Draining refuses WebSocket upgrades with 503, rather than rejecting credentials,
so workers can reconnect to the successor pinned instance.
