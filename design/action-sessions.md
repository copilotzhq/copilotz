# Action session effects and bounded flows

## Current state

- `runtime/engine/database-scope.ts:429` admits protected requests in the
  serialized owner command and commits their operation, body and flow binding
  together. An admission refusal still rolls back every new event.
- `runtime/authorization/flow.ts:5` validates flow lifetime, original delivery
  proof and the exact captured operation/run. Its operation read check at line
  72 includes the accepted continuation before capture.
- `runtime/actions/authorized-capture.ts:211` reauthorizes the Action using
  owner-retained provenance and supplies its resolved source operation.
- `runtime/application/ingress/authority.ts:128` proves completed credential
  replay against immutable ingress, selected scope and committed effects.
- `server/actions.ts:97` projects committed effects on replayed submission;
  `server/actions.ts:123` recovers the result and rechecks projection authority.
- `client/index.ts:116` keeps the active flow separately from exact submission
  and operation credentials, including completed replay and observation.

## Target and API

Actions stage effects in their existing transaction:

```ts
await context.transaction(async ({ collections, sessions, flows }) => {
  await collections.accounts.update({ id: accountId, lastLogin: now });
  await sessions.create({ principal: accountId, maxAge: 3600 });
});
await context.transaction(async ({ sessions }) => {
  await sessions.revoke();
});
await context.transaction(async ({ flows }) => {
  await flows.start({
    kind: "oauth",
    continuation: "oauthCallback",
    maxAge: 300,
  });
});
```

Session/flow methods return no credential. The owner derives stable IDs from
namespace, invocation and transaction identity; effect records carry only public
claims. Session tokens and flow credentials are domain-separated HMACs derived
from the existing wrapped owner data key. Tokens are reconstructed only at the
HTTP projection boundary. A Secret Adapter is required, as for protected
Actions.

Session grants remain `sessions.create` and `sessions.revoke` on the exact
`session` intent, now with owner-resolved Action identity. Flow creation
requires `flows.start` naming the permitted flow kinds. Continuation
registration uses an Action alias. Flow lifetime is bounded to fifteen minutes;
the default is five. Admission reserves one continuation operation. Capture
consumes that reservation for one retained Action run; re-authorizing that run
is allowed, and competing submissions are refused before dispatch.

The existing transaction planner stages these effects alongside collection
writes. It commits all effects, writes and transaction receipts atomically and
rejects use without a live Action invocation. The connected-worker transaction
plan supports the same methods and owner validation. There is no separate Action
execution path.

The SDK supplies a random delivery proof; only its hash enters retained
authority. This prevents shared anonymous grants from disclosing another
browser's cookie. Transfer creates the replacement then revokes the old session
inside the same transaction.

Owner-private effect rows link exact source operation, Action run and
originating principal to session/flow claims. Neither token nor signing material
is written to those rows, lifecycle output, receipts, operation metadata or live
reads. Replaying the same transaction verifies its original intent and does not
mint another session. HTTP projection follows the originating operation,
including effects from nested Actions. Logout invalidates open channels after
commit. Its own operation and already-captured callers may finish and recover
the clear-cookie effect after self-revocation; this does not revive the session
or grant other operations.

The host still selects tenant, schema and policy in `authenticate`. The facade
then validates a configured session cookie or `x-copilotz-flow` against that
selected scope. A flow is a bounded principal with owner-enforced restrictions,
even when host policy is broad: only its continuation and exact associated
operations are accessible. Collection/asset/general channel access is refused.

`defineServerFacade({ sessionCookie: { name, path, secure, sameSite, domain } })`
configures projection. Defaults are a host-only cookie, `/`, HttpOnly, Secure,
SameSite=Lax. Max-Age is remaining session lifetime; logout uses zero.
Projection requires the original initiating credential (or the created session
itself), not merely permission to read an operation. Responses are no-store.
Operation authorization and credential reconstruction share one owner command,
so a previously authorized read cannot bypass later revocation or policy
changes.

A flow-start result carries the credential in a response header. The SDK retains
it in memory, attaches it only to continuation and associated observation
requests, and lets the browser handle session cookies. Independent clients
isolate concurrent flows.

## Deletions and storage

Refactor existing create/revoke bodies into command-aware service operations;
custom HTTP handlers retain their API through that same service. No alternate
session implementation or feature flag. Owner-private credential-effect and flow
state remain in the existing schema. Version 15 adds `accepted_operation` to
`authorization_effects`. The offline v14-to-v15 step in
`runtime/authorization/credentials-upgrade.ts:42` requires drained work,
backfills already-consumed flow bindings, preserves consumed run IDs and fences
the owner. There is no startup migration. The existing offline upgrade command
runs it.

## Guarantees and tests

- Login/transaction replay/logout: stable cookie, one session, channel revoked.
- Atomic rollback and policy refusal: no session, effect, receipt or partial
  write.
- No session token in JSON, durable history, receipt data or live operation
  reads.
- Flow signature, tenant binding, kind/continuation restriction, expiry, single
  consumption, same-run replay and exact operation observation.
- Cookie configuration validation and SDK propagation; connected-worker plans.
- Core tests against PGlite and Postgres on port 55433; full suite at the end.

## Risks

Authorization rechecks after logout must distinguish its own completion from
fresh work. Async submission means cookie delivery occurs on committed result
recovery, including SDK result fetches. Flow credentials remain bearer secrets
in browser memory and require HTTPS. Deployments need the configured Secret
Adapter and a provisioned current schema; credentials must never be logged.

## SESS2 replay contract

An accepted continuation receipt is readable immediately with its signed flow
credential and original SDK delivery proof, before a worker captures it. A
pending result stays pending. The same flow cannot admit another operation, even
during this interval. Read/observe access remains exact to the start and
accepted continuation; signature, tenant, proof and expiry checks still apply.

A completed credential submission may replay its original body and identity with
its original proof, selected scope and current result-read permission, within
its flow/effect lifetime. The owner verifies that any credential change matches
the operation's own effects. A created session can replace the initiating
credential; self-logout can return to the host's anonymous grant. This permits
only recovery of the existing operation. It cannot create work, upgrade retained
ingress, reopen a consumed flow or mint a replacement session.

The original result and live effect projection are delivered again. Session
projection also checks that the session has not been revoked. Callback replay
uses the original flow credential retained by the SDK; the active flow is still
cleared after session projection. Logout clear-cookie projection expires at the
original invocation credential's admission deadline, at most fifteen minutes.
Expired flows refuse replay. Ordinary authenticated receipts do not gain
anonymous recovery merely because logout completed.

The owner retains raw request metadata separately from policy-derived operation
labels. Verified credential replay compares raw metadata and body exactly, then
uses the original accepted labels. A credential-dependent label change does not
cause `idempotency_conflict`; changed caller metadata or input still does.
Retained admissions without raw metadata keep conservative comparison and may
normalize only keys derived by the current policy. No public API changes.

The SDK retains flow credentials in memory by method/path/idempotency key and
operation ID. Exact retries and associated result/observation reads use their
original credential, including after a newer flow starts. Fresh callbacks need a
current flow. Independent SDK instances have different random proofs.

## Regression coverage

- `server/action-sessions.test.ts`: hold the sole worker with an explicit gate;
  submit the continuation and prove no capture exists; observe its pending 202
  through the SDK; reject a different flow/client/tenant and competitor; release
  the gate and recover the cookie. Completed replay returns the same cookie and
  executes once. Changed input, new identities and expired flow are refused.
- The same file uses flow-only callback and session-only logout grants, plus
  credential-dependent metadata. Browser cookie install/clear cycles preserve
  replay. Logout replay redelivers clear-cookie; ordinary authenticated
  receipts, altered input/metadata/proof/tenant, expired recovery and denied
  reads fail.
- `client/flow-credentials.test.ts`: exact operation and observation credentials
  survive active-flow clearing and newer flows without reaching unrelated reads.
- `runtime/actions/upgrade.test.ts`: offline v14-to-v15 replay preserves and
  backfills consumed identity; the full retained-data upgrade chain still works.
- Existing Action session, connected-worker transaction and device suites remain
  required, followed by full PGlite and PostgreSQL suites on port 55433.
