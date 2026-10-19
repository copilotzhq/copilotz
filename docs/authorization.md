# Owner authorization

Authorization is a breaking owner contract in schema version 12. The gateway
only authenticates and routes to the tenant owner. Authentication returns an
`AuthenticatedAuthority` binding with principal, explicit owner/database/tenant/
namespace scope, validity, policy ID and revision, immutable request facts,
provenance, dependencies and authority basis. Creator attribution never grants
credential authority.

Configure `authorization.policies`, `authorization.collections` and
`authorization.actions` on the application. Every policy has a `revision`, a
`sources` array of registered Collection aliases and an `evaluate` function.
Resource entries reference `{id, revision}`. Exposed resources and Collections
with `ownerPolicy: "required"` need complete registrations before startup.
Workers cannot register policy. Old `authorize`, `collectionPolicies`,
`protectedActions`, `ownerHooks` and bootstrap route registrations are rejected.

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
Missing, duplicate, stale, conflicting and unknown-revision entries abort the
transaction. Lifecycle bodies, encrypted values and existing capture receipts
remain byte-for-byte unchanged; preparation is never rerun.

The upgrade locks the schema, records a manifest digest, advances the owner
epoch and version marker, and invalidates retained live channels. Repeating the
same manifest is idempotent; a different manifest is refused. Clients reattach
and reauthorize after restart. Unknown policy revisions fail closed for new
protected work. Settlement of already begun effects remains available.
