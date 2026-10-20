# Public device hosting

## Current state

- `create-copilotz.ts:84` constructs one facade with recovery admission, but no
  WebSocket upgrade. Both embedded and gateway public handles therefore miss
  browser subscription hosting.
- `server/facade.ts:593` already owns `/device`, authentication, exposure and
  the existing `attachDeviceSocket` binding. Its upgrade accepts a request
  deadline.
- `runtime/application/hosting.ts:66` associates public handles with their owner
  Hypervisor and creates an HTTP-only Hypervisor for embedded handles.
- `runtime/adapters/{deno,node}/listen.ts` delegate native listeners to Oxian.
- Oxian 0.22 `src/adapters/node/server.ts:126` calls synchronous
  `hypervisor.prepare`, then either rejects with a response or upgrades and
  attaches a public `SocketConnection`. Its application fallback accepts only
  Response, not an asynchronous application upgrade decision.

## Target and public API

Add `upgradeDevice(request)` to public embedded/gateway factory options, using
exactly the facade upgrade contract (socket, response, optional epoch deadline).
Custom hosts use `app.fetch`; ordinary apps use either public `listen(app)`. No
new device endpoint or authentication implementation.

Listeners inject a request-local upgrade context into the existing facade. Deno
uses `Deno.upgradeWebSocket` on the original served Request. Node adapts Oxian's
existing public prepare/attach decision and SocketConnection contract; worker
decisions remain untouched. A small bounded deferred socket bridges native
attachment and asynchronous facade admission. Device messages are released only
after admission and facade binding finish. Failed admission closes the socket
and discards pending messages. Explicit upgrades take precedence.

The smallest upstream improvement would be allowing `prepare` (or an application
upgrade fallback) to return a Promise of a request decision. That would allow
Node to finish asynchronous admission before sending HTTP 101. With 0.22, the
native Node handshake can precede recovery admission, but no device frames are
processed before admission. Report this limitation rather than fork Oxian or
build another listener.

## Guarantees and deletions

- The same facade handles authentication, retained authority, revocation,
  deadlines, exposure and subscriptions for custom and built-in hosts.
- Request-local state avoids global runtime defaults and cross-listener races.
- Existing worker socket paths/admission take precedence; no worker protocol is
  interpreted as a device protocol.
- Oxian retains listener shutdown, connection budget and native socket
  ownership.
- Replace docs' private application/facade hosting example with public factory
  and listen. No production files are deleted.

## Validation

Real Deno and Node adapter listeners: browser WebSocket auth, snapshot, pushed
commit delta, permission-source/session revocation, custom upgrade/deadline,
ordinary HTTP behavior and worker coexistence. Run existing public hosting
contracts, device tests, Node runtime smoke and boundary checks. Run full test
suite once with PGlite and once with Postgres on 55434, under the prescribed
3600-second timeout. Record counts and unrelated failures.

## Risks

Node's synchronous prepare API requires the bounded attachment bridge above.
Native upgrades cannot use ordinary Fetch response status/header rewriting.
Custom upgrades own their returned socket and must match the selected runtime.
