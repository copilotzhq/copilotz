# Action session effects and bounded flows

## Current state

- `server/facade.ts:219` exposes session create/revoke only to custom HTTP
  handlers. `runtime/authorization/owner.ts:413` owns policy, tenant records and
  post-commit channel revocation.
- `runtime/actions/types.ts:225` exposes a transaction with collection, relation
  and vector plans. `runtime/collections/kernel.ts:4149` plans outside SQL and
  commits the ordered plans through one owner command and receipt.
- `runtime/actions/authorized-capture.ts:211` reauthorizes the captured Action.
  Invocation authority comes from owner-retained provenance, not Action
  metadata.
- `server/actions.ts:27` returns an asynchronous operation receipt;
  `server/actions.ts:114` recovers the committed result. Both transports must
  project effects without putting credentials in result data.
- `client/index.ts:110` owns fetch, submission and result/observation recovery;
  `client/web/runtime.ts:532` delegates server Actions to its injected
  transport, which can use the same SDK client's submission and result methods.

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
the default is five. Continuation admission consumes the flow once for its
retained Action run; re-authorizing that same run is allowed, competing runs are
refused.

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
session implementation or feature flag. Add owner-private credential-effect and
flow state tables to the schema contract (fresh schema version for this track).

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
