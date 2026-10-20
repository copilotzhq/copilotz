# Owner authorization

Authorization is a breaking owner contract in schema version 13. The gateway
only authenticates and routes to the tenant owner. Authentication returns an
`AuthenticatedAuthority` binding with principal, explicit owner/database/tenant/
namespace scope, validity, policy ID and revision, immutable request facts,
provenance, dependencies and authority basis. Creator attribution never grants
credential authority.

Configure `authorization.policies`, `authorization.collections` and
`authorization.actions` on the application. Every policy has a `revision`, a
`sources` array of local Collection aliases or explicit directory staff sources,
and an `evaluate` function. Resource entries reference `{id, revision}`. Exposed
resources and Collections with `ownerPolicy: "required"` need complete
registrations before startup. Workers cannot register policy. Old `authorize`,
`collectionPolicies`, `protectedActions`, `ownerHooks` and bootstrap route
registrations are rejected.

The owner evaluates `ServerConstraints` within each protected command. Policy
receives `authority`, `intent`, `commandTime`, `signal`, and revocable read-only
`read.get(alias, id)` and `read.list(alias, query)` capabilities. Declare all
source aliases; arbitrary SQL and recursive owner commands are unavailable. A
failed source read cannot be turned into a permanent permission refusal by
catching it. Empty queries and absent records remain dependencies.

Constraints include read predicates, explicit mutation and Action allowlists,
trusted input fields, authenticated root event types, Action metadata, operation
metadata/explicit absent keys, explicit record-to-asset read references, session
permissions and opaque `observationKeys` for catalog selections. Apply the
domain's selection-key helper in policy when selecting a conversation. Filters
run before pagination. Writes validate current and resulting scope. Action input
is captured once; retries reauthorize the original capture.

Collection policy also receives `intent.invocation?: {kind, id}`, where `kind`
is `action`, `processor` or `alarm`. Only the owner supplies this executing
identity; direct calls have no invocation. Nested Actions identify the immediate
executing Action. Run IDs and caller metadata cannot select this grant, and
attempt takeover still fences the call. Retained user authority remains present;
execution identity grants nothing unless the policy explicitly allows it:

```ts
if (
  intent.kind === "collection" && intent.resource === "participants" &&
  intent.operation === "create" &&
  intent.invocation?.kind === "action" &&
  intent.invocation.id === "threads.create" &&
  await mayCreateThreads(authority, read)
) {
  return { collectionMutations: { participants: { create: {} } } };
}
```

A platform-staff policy may declare an owner-qualified
`StaffAuthorizationSource` in `sources`, then use its alias with the same
`read.get` / `read.list` API:

```ts
sources: [{
  kind: "platform-staff",
  alias: "staffGrants",
  owner: "directory-owner",
  namespace: "directory",
  collection: "staff_grant",
  read: directoryStaffReads,
}];
```

`directoryStaffReads` is a trusted host-bound capability with
`get(id, signal, transaction)` and `list(query, signal, transaction)`.
`transaction` is the evaluating command's transaction. A directory in the same
database reads through it, read-only; on a single-connection backend such as
PGlite it must, because a second transaction cannot start. A directory in
another database issues its own fresh read to that owner. Either way the read is
fresh for this command; never use a cache or a tenant role reader. It receives
no tenant command authority. The source cannot shadow a local Collection alias.
The policy must check the staff principal, target tenant and requested operation
against the returned grant. Declaring or reading a source alone grants nothing.

For a directory Collection in the same database, use
`createDatabaseStaffSource({ alias, databaseSchema, namespace, collection })`
from `copilotz/engine`. It builds the source with reads that already run through
the evaluating command's transaction.

Every command reads the directory again. Repeated reads of the same source and
query within that command retain the first result, so it finishes under the
staff authority it read. A failed directory read refuses the command even if
policy catches the error. Directory and tenant reads are not one transaction.
Successful staff-source evaluations write `authorization.staff` receipts in the
tenant schema, in the operation's transaction, recording the principal, target
scope, provenance, policy, operation and directory source coordinates. Refused
transactions roll back these receipts with their effects. No new audit table or
cross-owner change notice is required. Staff channels use the existing admission
expiry and renewal path, capped at 15 minutes; tenant source invalidation
remains local.

API keys and enrolled device credentials use `credentialValidity(now)` for a
15-minute admission/channel lifetime. This does not expire the stored device
credential. Authentication must check the current credential record in its
tenant owner and policies must declare that source. Owner commands reject an
expired binding. An owner deadline closes idle channels with the lifetime
renewal control frame; the client SDK silently reauthenticates and reconnects
using its last committed checkpoint. Explicit revocation closes without renewal.
Worker authority carries an exact attempt, worker and owner epoch and retains
both executing and initiating identities. Owner alarm tasks use occurrence
identity and an explicit namespace entry in `authorization.systemScopes`;
namespace names are never inferred to be tenant identities.

`application.authorization.createSession(authority, {id, principal, expiresAt})`
and `revokeSession(authority, id)` execute in the tenant owner. Session policy
must grant `sessions.create` or `sessions.revoke` (`self` or `tenant`).
Protected commands validate session state in the same transaction. HTTP handlers
expose `context.sessions.create` / `revoke`. Logout must await `revoke` before
returning success or clearing its cookie. The revoke promise resolves after
commit and closes that session's channels; other tenants remain independent.

Committed source changes issue owner notices, which reauthorize affected open
observations. Every publication has a fresh owner gate, including buffered
payloads. Expiry uses owner alarms. There is no authorization polling.

## Offline upgrade from version 11

Stop producers and close transports. Run `scripts/upgrade-retained-data.ts` with
`authority-inventory` to export the retained inventory. Review every invocation
and ingress binding against application policy, then supply the explicit JSON
manifest through `--authority` to the `apply` command. Use the script's help for
database, schema and existing retained-content plan options.

The manifest declares supported policy IDs/revisions, exact invocation digests,
and exact ingress digests and bindings. An unclassified root additionally needs
explicit `ingress` provenance; the upgrade never guesses its identity. A capture
without an old preparation receipt needs an explicit `actionSchemas` snapshot.
For the v12 → v13 authority upgrade, every `authenticated-server` event entry
also requires `actorBinding`, exactly matching the full ingress `actor` object
(for example `{id: "participant-id", name: "Member"}`). This applies to both
retained classified ingress and explicitly reviewed unclassified ingress. The
credential principal and authority basis remain separate (for example a session
SID); the upgrade never rewrites the actor into a credential identity. The
reviewed event digest binds the original source provenance. Missing, duplicate,
stale, conflicting and unknown-revision entries abort the transaction. Lifecycle
bodies, encrypted values and existing capture receipts remain byte-for-byte
unchanged; preparation is never rerun.

The upgrade locks the schema, records a manifest digest, advances the owner
epoch and version marker, and invalidates retained live channels. Repeating the
same manifest is idempotent; a different manifest is refused. Clients reattach
and reauthorize after restart. Unknown policy revisions fail closed for new
protected work. Settlement of already begun effects remains available.

## Sessions and anonymous flows in Actions

Schema version 14 adds owner-private credential effects. Existing version 13
schemas use the offline `upgradeActionLifecycle` entry point with producers
stopped. The upgrade preserves existing sessions and authority bindings.
Configure the application's Secret Adapter: signing uses its wrapped owner data
key, so credential replay survives owner restart and key rewrapping.

Actions stage sessions inside their existing transaction. `maxAge` is seconds,
bounded to one year. No token is returned:

```ts
await context.transaction(async ({ collections, sessions }) => {
  await collections.accounts.update({ id: accountId, lastLogin: timestamp });
  await sessions.create({ principal: accountId, maxAge: 3600 });
});
```

Policy must explicitly return `sessions: { create: true }` for the `session`
`create` intent. Its input contains the owner-generated session ID, principal
and expiry, and `intent.invocation` identifies the executing Action. Check that
Action's identity and its authorized account before granting creation. A broad
Action grant alone cannot mint a session. Policy refusal rolls back the entire
transaction, including collection writes, effects and receipts.

`await sessions.revoke()` revokes the caller's session; `revoke(id)` targets a
specific session without clearing the caller's cookie when it targets someone
else. The `session` `revoke` intent requires `sessions: { revoke: "self" }` or
`{ revoke: "tenant" }`. For session transfer, create the replacement **before**
revoking the old session in the same transaction. The transport delivers the
replacement cookie. Logout commits revocation and closes that session's open
channels; the exact logout Action can finish and recover its result without
reviving authority for other operations. Session principal IDs identify
accounts; `authority.authorityBasis.id` identifies the particular session.
Existing fifteen-minute channel admission still applies.

For an anonymous flow, the start Action runs under an explicitly authorized
grant and stages a bounded credential:

```ts
await context.transaction(async ({ flows }) => {
  await flows.start({
    kind: "oauth",
    continuation: "oauthCallback",
    maxAge: 300,
  });
});
```

The `flow` `start` intent needs `flows: { start: ["oauth"] }` in policy.
`continuation` is a registered Action **alias**. Lifetime defaults to 300
seconds and cannot exceed 900 seconds. The signed credential binds schema,
namespace, tenant, flow kind, nonce and expiry. Its principal is the nonce, with
a validated `authority.flow` descriptor. The owner consumes it on the
continuation's first input capture. The same retained Action run may replay; a
second run is refused.

Flow restrictions apply in addition to policy. A flow can invoke only its
continuation, read or observe its start and continuation operations, and use the
continuation's explicitly granted internal collection/session operations. It
cannot read arbitrary Collections, assets or other flows' operations, even under
a broad host policy. Flow expiry bounds observation and every command.

Credential effects retain only public claims. Session tokens never enter Action
outputs, event bodies, operation metadata, transaction receipts or live reads.
The owner reconstructs them only for HTTP projection. Projection also requires a
client-held proof: a hash is bound to admission, so another caller sharing an
anonymous grant cannot obtain a session merely by reading its operation. The
projection command reauthorizes operation access before reconstructing a
credential, including current session revocation and policy constraints.
