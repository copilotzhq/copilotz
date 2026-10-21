---
title: "Owner Authorization"
description: "Decide what each authenticated caller may do with one versioned policy that the database owner evaluates inside every command, over declared Collection sources."
section: Deliver
order: 15
status: stable
---

# Owner Authorization

## The pain

The Notes API authenticates every request, but a valid credential is not a
permission. Ada may save notes; a reader in the same tenant may not. An
assistant turn that Ada started keeps calling tools after an administrator
removed her role. A browser tab keeps a live observation open for hours after
its user logged out. A check that runs in the HTTP process, reads a cache, or
decides once per request cannot answer these consistently, because the decision
and the write happen in different places and at different times.

## The problem

Authorization has to hold wherever and whenever the work runs:

- **Where.** The decision must be made where the data is written, in the same
  transaction, or a concurrent change makes it stale.
- **What it may read.** A policy that can run arbitrary SQL or start commands
  cannot be reviewed, and nobody can tell which changes should re-check it.
- **For how long.** Authority must expire and be revocable, including for open
  channels and for work that is already running.
- **On whose behalf.** An Action or Processor running for a user must be
  distinguishable from that user calling directly.

## The solution

Each database schema has one **owner**: a single serialized writer. Workers and
the HTTP gateway hold no database connection; they call the owner. The owner is
also where authorization runs.

1. **The gateway authenticates.** The server facade's `authenticate` callback
   returns a trusted scope that includes an `authority` binding
   (`AuthenticatedAuthority`): principal, owner, schema, tenant and namespace,
   validity, policy ID and revision, request facts, provenance, dependencies and
   the authority basis. The binding is data; it grants nothing by itself.
2. **The owner authorizes.** The application declares
   `authorization: OwnerAuthorization` on `createCopilotz`. For every protected
   command, such as an Action admission, a Collection read or write, an
   operation read, an observation, an Asset read or a session change, the owner
   runs the policy that the binding names, inside that command's transaction.
3. **The policy returns constraints.** A `ServerConstraints` object lists what
   is granted. Anything it does not name is refused.

The retained binding travels with the work it admitted. Actions, Processors and
tool calls that run for Ada later are authorized again under the same binding
and the current policy, by the owner, when each command runs.

### Register a policy

`notes-access.ts` is a **definition module**. It registers one policy that reads
a `member` Collection and guards the `saveNote` Action.
[Chapter 16](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md)
builds the same policy step by step, with the `authenticate` callback that mints
its bindings.

```ts
// Defines the Collection the policy reads.
import { defineCollection } from "@copilotz/copilotz";
// Type of the registration that `createCopilotz` accepts as `authorization`.
import type { OwnerAuthorization } from "@copilotz/copilotz";

// Who belongs to a tenant, and with which roles. Policy data, never exposed.
export const member = defineCollection({
  name: "member",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", readOnly: true },
      actorId: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
    },
    required: ["actorId", "roles"],
  } as const,
  // One membership per actor in each tenant.
  indexes: [{ fields: ["actorId"], unique: true }],
});

// Bindings name a policy and the exact revision they were written for.
export const notesPolicy = { id: "notes", revision: "2" } as const;

export const authorization: OwnerAuthorization = {
  policies: {
    [notesPolicy.id]: {
      revision: notesPolicy.revision,
      // The only data `evaluate` may read.
      sources: ["member"],
      async evaluate({ authority, intent, read }) {
        // Read inside the command being authorized, in the binding's tenant.
        const [membership] = await read.list("member", {
          where: { actorId: authority.principal.id },
          limit: 1,
        });
        if (!membership) return {};
        // Stamped on each operation at admission; only its initiator matches.
        const ownOperations = {
          operations: { metadata: { initiatorUserId: authority.principal.id } },
        };
        if (intent.kind === "action") {
          return (membership.roles as string[]).includes("editor")
            ? { ...ownOperations, actions: { saveNote: {} } }
            : {};
        }
        return ownOperations;
      },
    },
  },
  // Which policy guards each Action and Collection, keyed by alias.
  actions: { saveNote: notesPolicy },
  collections: {},
};
```

The registration has three maps:

- `policies` holds each policy by ID, with a `revision`, the `sources` it may
  read and its `evaluate` function. Change the revision whenever `evaluate`
  grants something different. A binding whose revision the owner no longer knows
  fails closed for new protected work; settlement of effects that already began
  remains available.
- `actions` and `collections` bind registry **aliases** (the keys of a plugin's
  `actions` and `collections` maps, such as `saveNote`), not stable IDs, to
  `{ id, revision }`. A binding only says which policy guards the resource. The
  owner refuses a caller whose authority names a different policy or revision
  than the resource's binding.
- `systemScopes` (optional) places owner-generated alarm occurrences in an
  explicit tenant for each namespace. Namespace names are never inferred to be
  tenant identities.

Startup rejects unknown aliases or revisions, any Action or Collection the
server facade exposes without a binding, and any Collection that declares
`ownerPolicy: "required"` without one. Server also checks adapter-declared
Collections, including core-http's `thread`, `participant` and `message`. A
Collection with no binding refuses reads and writes by non-host callers,
including custom routes. Trusted host code can still access it. Workers reject
`authorization`; only the owner evaluates policy.

The former `server.authorize` hook and the `ServerAuthorize`, `CollectionPolicy`
and `CollectionPolicies` types are removed. `defineServerFacade` rejects an
`authorize` option, and `createCopilotz` rejects `collectionPolicies` and
`protectedActions`.

### What `evaluate` receives

`evaluate({ authority, intent, commandTime, signal, read, evidence })` runs in
the owner's command:

- `authority` is the retained binding, validated and frozen.
- `intent` describes the exact command. `kind` is `action`, `collection`,
  `operation`, `observation`, `session`, `flow`, `asset`, `event`, `directory`
  or `identity`, with a `resource`, an `operation` and the captured `input`:
  - Action intents name the Action by alias. `operation` is `admit` at HTTP
    admission, `capture` when the owner captures the input, and `authorize` when
    execution or a replay checks it again.
  - Collection intents name the Collection by alias, and `operation` is the
    method (`get`, `list`, `query`, `create`, `update`, `delete`, `command`, …).
    `input` holds the method, the arguments, the phase and, for writes, the
    `current` and proposed `next` record.
  - Operation intents are `read` or `cancel`; observations `attach`; sessions
    `create` or `revoke`; Asset intents `read`.
- `commandTime` and `signal` are the command's time and cancellation.
- `read.get(alias, id)` and `read.list(alias, query)` read only the declared
  `sources`, in the binding's namespace, inside the command's transaction. Each
  read is a dependency, including a missing record or an empty result; a
  committed change to one re-authorizes the open observations that depended on
  it. Relation includes, raw SQL and owner commands are unavailable, and a
  failed read refuses the command even if the policy catches the error.

Collection intents also carry `intent.invocation?: { kind, id }`, where `kind`
is `action`, `processor` or `alarm`. Only the owner supplies this executing
identity; direct calls, such as HTTP route reads, have none. Nested Actions name
the immediate executing Action, and run IDs or caller metadata cannot select the
grant. The user's retained authority is still present, and the invocation grants
nothing unless the policy says so. This excerpt from
[Chapter 17](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md)
lets Core's own Actions and Processors write threads for a member while direct
reads get only a membership filter:

```ts
const memberThreads = {
  thread: { contains: { participantIds: [actorId] } },
};
if (intent.kind === "collection") {
  return intent.invocation
    ? {
      collections: memberThreads,
      collectionMutations: {
        thread: { create: {}, update: {}, commands: { ensureMembership: {} } },
      },
    }
    : { collections: memberThreads };
}
```

### What `evaluate` returns

`ServerConstraints`, exported from `@copilotz/copilotz` and
`@copilotz/copilotz/server`. Every field is a grant; omit it to refuse.

| Field                 | Grants                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions`             | An allowlist keyed by Action alias. Each entry may force trusted `input` fields; a conflicting caller value is refused.                                                                                         |
| `actionMetadata`      | Trusted metadata added to the Action invocation.                                                                                                                                                                |
| `collections`         | A read filter per Collection (`where`, `contains`, `containsAny` or `filter`), keyed by alias or name. Required for every read and applied before pagination and aggregation. `{}` allows every record.         |
| `collectionMutations` | `create`, `update`, `delete` and named `commands`, each with optional `fields` allowlist, trusted `input` and a `filter` that the current and resulting record must match. Read filters never authorize writes. |
| `operations`          | `{ metadata, absentMetadata? }`. Admission stamps `metadata` onto the operation; reads, observation and cancellation treat a non-matching operation as not found.                                               |
| `observationKeys`     | Opaque catalog keys stamped on admitted work, such as a conversation's selection key from that domain's helper.                                                                                                 |
| `assets`              | `{ read: [assetId, …] }`: exact Assets the caller may read.                                                                                                                                                     |
| `sessions`            | `{ create?: { principal, maxAge }, revoke?: "self" \| "tenant" }`.                                                                                                                                              |
| `flows`               | `{ start: { [kind]: { continuation, maxAge } } }`: exact continuation alias and maximum lifetime.                                                                                                               |
| `events`              | Authenticated root Event types, including adapter-validated channel input.                                                                                                                                      |
| `admission`           | `{ key }`: the host-selected conversation group for bounded HTTP admission. Product labels, such as a thread link, travel in `operations.metadata`.                                                             |

Writes validate both the current and the resulting scope. Action input is
captured once, atomically with its retained authority; retries re-authorize that
capture instead of preparing the input again.

### Trusted host calls

`app.actions.<alias>`, `app.collections.<alias>` and `app.send` run as the
trusted host when called by host code, such as startup, scripts, administration
and tests. Host calls need no policy grant, including for unbound Collections.

Inside an Action, a Processor or an HTTP route handler, ambient `app.*` calls
carry the caller's authority. They cannot widen it to trusted-host authority.
The context APIs (`context.actions`, `context.collections`, `context.invoke` and
`context.read`) carry that authority too. A Collection without an owner policy
binding is forbidden to authenticated callers, for both reads and writes.
Explicit `withRetainedAuthority(authority, signal, fn)` scopes from
`@copilotz/copilotz` retain the same guarantee.

Separate workers install a revocable ambient binding around every user callback:
Action execute/resume/reconcile, Processor handle/onError and prepare factories.
The binding survives awaits. Captured same-scope application Action and
Collection calls use the worker's existing reverse capability and the context
retained by the owner, including parent provenance and current policy. No host
authority is sent over the wire. Foreign schemas/namespaces and unsupported host
ingress are refused; use context capabilities for execution and declared
directory reads for delegation. Captured application calls accept
`idempotencyKey`, `metadata` and `signal`; scope options may only name the
current owner scope. Independent host bootstrap remains trusted.

Policy Collection filters accept only `where`, `contains`, `containsAny` and
`filter`. The owner validates their shapes and nested predicates before using a
decision, including mutation filters; malformed filters are refused.

### Sessions and logout

A session is an owner record in the tenant. Create and revoke it from HTTP route
handlers, which receive `context.sessions`. `session-routes.ts` is a
**definition module**:

```ts
// Declares application HTTP routes for the server facade.
import { createHttpAdapter } from "@copilotz/copilotz/server";

// Eight hours, after which the owner refuses the session.
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

// Login and logout. `authenticate` has already verified the login request's
// credentials; these handlers only record the outcome in the tenant owner.
export const sessionRoutes = createHttpAdapter({
  routes: [
    {
      id: "auth.login",
      method: "POST",
      path: "/login",
      async handler(context) {
        const id = crypto.randomUUID();
        // The policy must grant `sessions.create` to this request.
        await context.sessions.create({
          id,
          // The session ID is also the principal ID of every later request.
          principal: id,
          expiresAt: new Date(Date.now() + sessionLifetimeMs).toISOString(),
        });
        return Response.json({ ok: true }, {
          headers: { "set-cookie": `sid=${id}; HttpOnly; Secure; Path=/` },
        });
      },
    },
    {
      id: "auth.logout",
      method: "POST",
      path: "/logout",
      async handler(context) {
        // Revokes the request's own session and closes its open channels.
        // Clear the cookie only after the revocation has committed.
        await context.sessions.revoke();
        return Response.json({ ok: true }, {
          headers: { "set-cookie": "sid=; Max-Age=0; Path=/" },
        });
      },
    },
  ],
});
```

Register it as `adapters: { http: { auth: sessionRoutes } }`. The rules:

- `authenticate` verifies the login request itself (a password, a one-time code,
  an identity-provider callback) and returns a credential binding whose policy
  grants `sessions: { create: { principal: accountId, maxAge: 28800 } }` for
  session intents.
- Later requests carry the session ID. `authenticate` returns a binding with
  `principal: { kind: "session", id: accountId }` and
  `authorityBasis: { kind: "session", id: sessionId }`. `sessions.create` binds
  the session ID to its principal; they may differ. Every command checks both
  against the stored session row.
- Every protected command checks the session row in its own transaction. An
  unknown, expired or revoked session is refused, and an admission never
  outlives its session's `expiresAt`.
- `context.sessions.revoke(id?)` defaults to the request's own session. The
  policy grants `revoke: "self"` for the caller's own session or `"tenant"` for
  any session in the tenant. The promise resolves after commit and closes that
  session's open channels; other tenants are unaffected.

### Lifetimes and open channels

- `credentialValidity(now, credentialExpiresAt?)` returns an admission of at
  most 15 minutes. API-key and device principals cannot hold a longer one. It
  does not expire the stored credential; `authenticate` must check the current
  credential record, and a policy that depends on it declares it as a source.
- The owner rejects an expired binding. An owner deadline closes an idle channel
  with a renewal control frame; the client SDK authenticates again and
  reconnects from its last committed checkpoint. Explicit revocation closes it
  without renewal.
- Every publication on an open observation passes a fresh owner check, including
  buffered payloads, and committed source changes re-authorize the affected
  observations. Expiry uses owner alarms; nothing polls.
- Work running on a Worker carries an attempt-bound authority (the attempt,
  worker and owner epoch) and keeps both the executing and the initiating
  identity. Owner alarms use occurrence identity and the namespace's
  `systemScopes` entry.

### Platform staff

Support staff who act across tenants are authorized from a platform directory,
never from tenant data. Declare a `StaffAuthorizationSource` in the policy's
`sources`, then read it through the same `read` API. For a directory Collection
in the same database, `createDatabaseStaffSource` from `@copilotz/copilotz`
builds the source with reads that run, read-only, through the evaluating
command's transaction. On a single-connection backend such as PGlite it must,
because a second transaction cannot start.

```ts
// The Collection definer and the staff-source builder.
import {
  createDatabaseStaffSource,
  defineCollection,
} from "@copilotz/copilotz";
// Type of the registration that `createCopilotz` accepts as `authorization`.
import type { OwnerAuthorization } from "@copilotz/copilotz";

// The platform directory's grants, stored in their own schema.
export const staffGrant = defineCollection({
  name: "staff_grant",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", readOnly: true },
      staffId: { type: "string" },
      tenant: { type: "string" },
      operations: { type: "array", items: { type: "string" } },
    },
    required: ["staffId", "tenant", "operations"],
  } as const,
});

// Fresh reads of the directory for every command that evaluates the policy.
const staffGrants = createDatabaseStaffSource({
  alias: "staffGrants",
  databaseSchema: "directory",
  namespace: "directory",
  collection: staffGrant,
});

const supportPolicy = { id: "support", revision: "1" } as const;

export const authorization: OwnerAuthorization = {
  policies: {
    [supportPolicy.id]: {
      revision: supportPolicy.revision,
      sources: [staffGrants],
      async evaluate({ authority, intent, read }) {
        // Check the staff principal, the target tenant and the operation.
        // Declaring or reading the source grants nothing by itself.
        const [grant] = await read.list("staffGrants", {
          where: {
            staffId: authority.principal.id,
            tenant: authority.scope.tenant,
          },
          limit: 1,
        });
        const operations = (grant?.operations ?? []) as string[];
        return intent.kind === "operation" &&
            operations.includes(intent.operation)
          ? { operations: { metadata: {} } }
          : {};
      },
    },
  },
  actions: {},
  collections: {},
};
```

A directory in another database supplies its own `read` capability, with
`get(id, signal, transaction)` and `list(query, signal, transaction)`, that
issues a fresh read to that owner. Never use a cache or a tenant role reader;
the source receives no tenant command authority and cannot shadow a local
Collection alias.

Every command reads the directory again. Repeated reads of the same source and
query within one command return the first result, so the command finishes under
the staff authority it read. A failed directory read refuses the command even if
the policy catches the error. Directory and tenant reads are not one
transaction. Each successful staff evaluation writes an `authorization.staff`
receipt in the tenant schema, in the operation's transaction, recording the
principal, target scope, provenance, policy, operation and directory source; a
refused transaction rolls the receipt back with its effects. Staff channels use
the same 15-minute admission and renewal path.

### Declared directory reads from Actions

`context.directory.get(alias, id)` is a read-only capability for a directory
Collection in another owner schema **in the same database**. Declare it in
`authorization.directoryReads`; placement, Collection, fields, byte limit and
eligible Action aliases are fixed by trusted composition. Caller input selects
only the declared alias and record ID. There are no list, write or destination
selection methods, and Processors or independent host calls cannot use it.

```ts
import { defineDatabaseDirectoryRead } from "@copilotz/copilotz/engine";

const routing = defineDatabaseDirectoryRead({
  revision: "1",
  databaseSchema: "directory",
  namespace: "directory",
  collection: routes,
  actions: ["enroll"], // registered, policy-bound Action aliases
  fields: ["tenant"], // exact top-level projection, no implicit fields
  maxBytes: 4096, // default 16384, maximum 65536
  authorize({ authority, id, record }) {
    // Destination owner policy; inspect fresh state and the retained caller.
    return record?.active === true &&
      record.requester === authority.principal.id && record.id === id;
  },
});
// Add to the application's authorization registration:
// directoryReads: { routing }
```

The caller's policy must separately return `directoryReads: ["routing"]` for
`intent.kind === "directory"`, `intent.operation === "get"`. Inspect the exact
`intent.input.id`, caller scope and `intent.invocation` before granting it. The
source policy is checked before reading and again before disclosure; the
declared destination policy must return exactly `true`. Missing declarations,
undeclared Actions, denial, expired authority, cancellation, unavailable storage
and oversized results all fail closed. The destination policy receives a
detached record and retained authority, not a database handle. It must not
perform writes.

```ts
const route = await context.directory.get("routing", routingRecordId);
```

Each call reads current committed directory state through the existing owner
command transaction; no identity result is cached or replayed by this API.
Successful reads commit an `authorization.directory` receipt before disclosure.
Its intent records caller principal, source tenant/namespace, operation and
Action provenance, declaration revision, destination scope/Collection, projected
fields, record ID and result digests, and command time. The receipt contains no
credential or returned record payload. Audit-write failure prevents disclosure.
Refused reads disclose nothing and roll back with the command; they do not
create successful-read receipts.

This capability also works through the worker transport, where the owner
resolves the declaration from its own registration. It does not grant
cross-owner mutations, transactions, arbitrary queries, or reads from another
database. Mutations use the separately declared directory service commands
below. Staff authorization sources remain restricted to policy evaluation and
are not a business directory API.

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

Policy must explicitly return
`sessions: { create: { principal: accountId, maxAge: 3600 } }` for the `session`
`create` intent. Its input contains the owner-generated session ID, principal
and expiry, and `intent.invocation` identifies the executing Action. Check that
Action's identity and independently verified account before granting creation. A
broad Action grant alone cannot mint a session. Policy refusal rolls back the
entire transaction, including collection writes, effects and receipts.

This is also the recommended remote login configuration. The owner compares the
proposed principal and expiry with the grant before inserting a session or
effect row. The maximum lifetime must be a positive integer; booleans no longer
grant creation. A compromised worker cannot substitute another principal or
extend the grant's lifetime. Derive the grant from trusted owner state or
independently validated authentication evidence, never by echoing
`intent.input`. Keep signing keys on the owner; a worker proposes effects and
receives no credential token.

`await sessions.revoke()` revokes the caller's session; `revoke(id)` targets a
specific session without clearing the caller's cookie when it targets someone
else. The `session` `revoke` intent requires `sessions: { revoke: "self" }` or
`{ revoke: "tenant" }`. For session transfer, create the replacement **before**
revoking the old session in the same transaction. The transport delivers the
replacement cookie. Logout commits revocation and sends a terminal session
notice to every device authenticated with that session, then closes each with
code 4401, even when no collection channels remain; the exact logout Action can
finish and recover its result without reviving authority for other operations.
Session principal IDs identify accounts; `authority.authorityBasis.id`
identifies the particular session. Existing fifteen-minute channel admission
still applies.

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

The `flow` `start` intent needs an exact owner grant:
`flows: { start: { oauth: { continuation: "oauthCallback", maxAge: 300 } } }`.
The owner compares the requested continuation and lifetime with that grant
before creating an effect. Kind arrays no longer authorize minting.
`continuation` is a registered Action **alias**. Lifetime defaults to 300
seconds and cannot exceed 900 seconds. The signed credential binds schema,
namespace, tenant, flow kind, nonce and expiry. Its principal is the nonce, with
a validated `authority.flow` descriptor. The owner consumes it on the
continuation's first input capture. The same retained Action run may replay; a
second run is refused.

Flow restrictions apply in addition to policy. The credential can directly
invoke only its continuation and read or observe its start and continuation
operations. Inside the consumed continuation, `context.actions` may invoke
transitive child Actions within that exact accepted operation. Each child still
needs an exact product Action grant; its internal Collection, session, asset and
directory capabilities still require their own grants. Policy receives
`intent.invocation`, including the owner-resolved parent run at child capture.

The owner records each descendant's flow, consumed root, accepted operation,
parent and Action identity in the same transaction as policy and input capture.
A refused child leaves no delegation receipt. Other operations, tenants and
direct child calls remain refused; replay returns retained results without
re-running children. Flow expiry and current authorization checks apply to every
command. `operations.start` and `awaitOperation({ start })` refuse a flow before
admitting another operation. Detached Processors retain the flow and cannot
become admitted Action descendants. Collection alarms and scheduled occurrences
run with independently configured `systemScopes` and current owner policy, not
the originating flow. Granting a flow permission to write a schedule does not
authorize the occurrence's Actions or effects; its independent policy must grant
them explicitly.

Credential effects retain only public claims. Session tokens never enter Action
outputs, event bodies, operation metadata, transaction receipts or live reads.
The owner reconstructs them only for HTTP projection. Projection also requires a
client-held proof: a hash is bound to admission, so another caller sharing an
anonymous grant cannot obtain a session merely by reading its operation. The
projection command reauthorizes operation access before reconstructing a
credential, including current session revocation and policy constraints.

## Reference

### Upgrading retained authority (v12 → v13)

Schema v13 is installed only by the explicit offline chain in
[Upgrading](upgrading.md#current-owner-schema-v13). Its last step converts
retained authority:

- Stop producers and close transports. Run `scripts/upgrade-retained-data.ts`
  with `authority-inventory`, and review every invocation and ingress binding
  against application policy. Supply the reviewed JSON manifest through
  `--authority` to the `apply` command; the script's help lists the database,
  schema and retained-content plan options.
- The manifest declares supported policy IDs and revisions, exact invocation
  digests, and exact ingress digests and bindings. An unclassified root needs
  explicit `ingress` provenance; the upgrade never guesses its identity. A
  capture without an old receipt needs an explicit `actionSchemas` snapshot.
- Every `authenticated-server` event entry also requires `actorBinding`, exactly
  matching the full ingress `actor` object (for example
  `{ id: "participant-id", name: "Member" }`). The credential principal and the
  authority basis stay separate, and the upgrade never rewrites the actor into a
  credential identity.
- Missing, duplicate, stale, conflicting and unknown-revision entries abort the
  transaction. Lifecycle bodies, encrypted values and capture receipts remain
  byte-for-byte unchanged; nothing is prepared again.
- The upgrade locks the schema, records a manifest digest, advances the owner
  epoch and the version marker, and invalidates retained live channels.
  Repeating the same manifest is idempotent; a different manifest is refused.
  Clients reattach and re-authorize after restart.

## What this unlocks

- One reviewable place that decides what every caller may do, evaluated where
  the data is written.
- Permission changes, revocations and logouts that apply to the next command, to
  work already running and to open channels, without polling.
- Agents and Processors acting with exactly the user's authority, plus the
  explicit grants you give their own Actions and Processors.
- Tenant data, sessions and audit receipts that stay inside the tenant's own
  schema.

## Next steps

- Tutorial:
  [Chapter 16: Authenticate and Isolate Tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md)
  builds a policy, its bindings and tests.
- Tutorial:
  [Chapter 17: Connect Chat and Channels](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md)
  extends it to Core's conversation routes.
- Reference: [HTTP server and browser client](server.md) covers `authenticate`,
  routes and observation.
- Reference: [Upgrading](upgrading.md) covers the offline v13 chain.

## Device and live-read admission

`/device` checks Origin before either Deno or Node upgrades the connection.
Same-origin is allowed; additional canonical HTTP(S) origins require
`allowedOrigins` on the server facade. Missing Origin is only for header-token
clients: cookies are removed from captured headers and cannot be supplied in
hello. Host authentication must use the supplied request without ambient cookie
fallback. Same-origin browsers can explicitly select their captured HttpOnly
cookie with `{ cookie: true }`; empty hello credentials are refused.

Action sessions default to `__Host-copilotz_session`, with Secure, HttpOnly,
Path=/ and no Domain. The Host-prefix attributes are validated, and duplicate
cookies with the configured name are refused with `duplicate_session_cookie`.
Credential tokens use an HKDF-derived HMAC key with a credential-specific label.
The protected-value commitment key is unchanged, preserving shipped data.

Live queries and policy constraints share bounded admission. Defaults allow 32
attached states per tenant/principal and 16 per device socket, 64 predicate
nodes, and 32 `in`/`overlaps` values. Expensive or non-equivalent filters are
refused, including `jsonEquals` and locale-dependent case folding. String ranges
use Unicode code-point/C ordering. See
[the complete limits and accepted filters](./subscriptions.md).
`subscription_query_refused` and `subscription_capacity_exceeded` distinguish
query refusal from capacity. Detached readers do not consume active admission;
retained history is bounded and evicted before denying active capacity.

Invisible Collection mutations emit no live frame: policy matching checks both
the old and new image, including exits and progress-only reads. Progress and
Action settlement use namespace-local event counts, so another namespace's
commits cannot advance a subscriber's sequence. Existing permission notices,
revocation, scope resets and checkpoint identity checks still gate publication.

HTTP ingress stores the authenticated `scope.actor` separately from retained
`authority.principal` and `authority.authorityBasis`. Session authentication
does not replace actor attribution with a session or account ID. Offline v14
manifests use `actorBinding` to review that same actor independently of
authority.

Action grants, Action policy registrations, HTTP exposure, HTTP route `action`,
handler `context.invoke`, client Action calls, flow continuations and Tool
bindings all use the composition alias (for example `saveNote`). Stable Action
IDs identify durable lifecycle events and are not alternate configuration keys.

### Completed self-logout receipts

The initiating credential proof can recover its completed self-logout operation
inside the original schema, namespace and tenant, until the recorded proof
receipt expires. Recovery matches the durable `session.revoke` effect, its
original session basis and proof digest. It grants no new Action execution,
collection access, cancellation or access to another operation. An observation
of that single operation returns only its completion notice, with no historical
Events or stream payloads. If revocation has committed but completion is still
pending, receipt observation waits on owner operation pushes for up to ten
seconds; a longer wait returns `operation_result_pending` (409) for retry. The
single writer is never held while waiting. Result polling returns 202 until
completion. If revocation commits during result or observation admission, the
server rechecks the same proof-bound receipt once. Ordinary Action-result
disclosure checks still apply. Operations that also issue replacement
credentials require the original session as well as its proof; a signed-out
proof cannot recover replacement credentials.

The device SDK exposes `onAuthState(listener)`, returning an unsubscribe
function. A session-level notice (or terminal 4401 close) emits
`{state:"revoked",code:"session_revoked"}` exactly once and prevents automatic
reconnection. Establish a new session and explicitly reauthenticate to
reconnect. A permission change for one collection remains a channel-level
revocation.

Anonymous HTTP Action access without credentials is 401; a supplied but refused
credential is 403, including Core HTTP Actions. An actor explicitly
authenticated by the host retains 403 on denial even without standard credential
headers. A direct host authentication refusal also becomes 401 when no
credential is present. A credential-projection proof is a receipt capability,
not an authentication credential. Cookie defaults remain
`__Host-copilotz_session`, Secure, HttpOnly, Path=/ and no Domain.

## Owner-verified identity evidence

Register a named `identityVerifiers` capability on the owner. An Action calls
`context.authentication.verify(alias, input)` before its transaction. Workers
can request a verifier; they cannot register one or supply its verified result.
An `externalEffect` checkpoint, even a persisted one, is never authentication
evidence.

The verifier is trusted owner code. Keep provider secrets, trusted issuer
configuration and signing-key caches there. For an OIDC code flow, it must
exchange the code and validate the ID token's signature, issuer, audience,
expiry and nonce against the owner-retained challenge, including PKCE. Do not
accept the expected issuer, audience, nonce or principal from the worker.

This generic example uses application-owned `loginChallenges` and `trustedOidc`
services; those names are not platform APIs:

```ts
import { defineIdentityVerifier } from "@copilotz/copilotz/engine";

const oidc = defineIdentityVerifier({
  revision: "1",
  actions: ["loginCallback"],
  async verify(input, { binding, exchangeKey, signal }) {
    const { code } = parseCodeInput(input); // Bounded untrusted input.
    const challenge = await loginChallenges.get(binding);
    // Service verifies against configured provider keys and owner-held nonce/PKCE.
    const identity = await trustedOidc.exchangeAndVerify({
      code,
      issuer: configuredIssuer,
      audience: configuredClientId,
      clientSecret: ownerClientSecret,
      nonce: challenge.nonce,
      pkceVerifier: challenge.pkceVerifier,
      exchangeKey,
      signal,
    });
    return {
      issuer: identity.issuer,
      subject: identity.subject,
      principal: accountIdFor(identity.issuer, identity.subject),
    };
  },
});
// authorization.identityVerifiers = { oidc }
```

The result is a bounded `IdentityEvidence` value with `issuer`, `subject`,
`principal` and optional JSON `claims`. Return only verified facts needed by
policy, never tokens, authorization codes or secrets. Inputs and evidence are
limited to 16 KiB. Policy declares `evidence: ["oidc"]`; its typed
`evidence.get("oidc")` reader accepts no caller-selected receipt or binding. It
reads only evidence for the current schema, namespace, tenant, flow, accepted
root operation and client proof. An undeclared read refuses, including when
policy catches the read error. Missing evidence is `null`.

```ts
// Excerpt from the login policy; ordinary admission grants are omitted.
const identityPolicy = {
  revision: "1",
  sources: [],
  evidence: ["oidc"],
  async evaluate({ intent, evidence }) {
    if (intent.kind === "identity" && intent.resource === "oidc") {
      return { identityVerifiers: ["oidc"] };
    }
    if (intent.kind === "session" && intent.operation === "create") {
      const identity = await evidence.get("oidc");
      return identity
        ? {
          sessions: { create: { principal: identity.principal, maxAge: 3600 } },
        }
        : {};
    }
    return {};
  },
};
```

Only a consumed flow Action or an admitted descendant in its accepted operation
can request verification. The owner durably reserves the exchange before
provider I/O, then records verified evidence before returning it. Repeated calls
with the same input and verifier revision return the same evidence. Changed
input or revision refuses. A pending reservation returns
`identity_evidence_pending`; it never re-exchanges a one-use code. If a crash
occurs after the provider consumes a code but before the receipt commits, start
a new flow. This is an explicit unresolved outcome, not a successful login.

Verification runs outside the SQL transaction. A later login rollback retains
the evidence, so replay does not repeat the provider exchange. Evidence expires
with the flow. Trusted host maintenance can call
`pruneIdentityEvidence(session, databaseSchema)` to remove expired evidence and
pending reservations. Payload-free `identity.audit` receipts remain under the
owner's audit retention policy. Protect private receipt storage and apply the
application's retention schedule to owner-held login challenges too.

## Atomic directory service commands

For provisioning, use a declared trusted identity-service command. This extends
`context.directory` with `command(alias, input, { operationKey })`, and Action
transactions with `tx.directory.command`. Composition fixes the destination
schema, namespace, command name, revision and permitted Action aliases. Source
policy must grant `directoryCommands: [alias]`; the destination's independent
`authorize` callback must also return `true`.

```ts
import { defineDatabaseDirectoryCommand } from "@copilotz/copilotz/engine";

const prepare = defineDatabaseDirectoryCommand({
  databaseSchema: "directory",
  namespace: "directory",
  command: "prepareLogin",
  revision: "1",
  actions: ["loginCallback"],
  evidence: ["oidc"],
  async authorize({ authority, input, evidence }) {
    const identity = await evidence.get("oidc");
    return admittedSourceTenant(authority.scope.tenant) &&
      identity?.principal === parseDirectoryInput(input).accountId;
  },
  async execute({ transaction, namespace, input }) {
    // Trusted service repository; only this supplied SQL transaction may write.
    return await directoryRepository.prepare(transaction, {
      namespace,
      ...parseDirectoryInput(input),
    });
  },
});
// authorization.directoryCommands = { prepare, publishMembership }
```

The directory service owns its repository and migrations. Its callbacks run on
the owner, never on a worker. Use the supplied SQL executor for service-owned
tables and joined source reads. For native Collections, use the destination
Collection repository described below: raw writes to native tables omit their
events, indexes and integrity checks. The SQL executor is revoked when the
implementation returns. No captured application handles, network side effects or
independent commits are permitted in a service command. Physical tenant
provisioning belongs to trusted host orchestration before route activation.

Both schema owners must already be attached in the same process and database.
The source SQL transaction locks and verifies the destination's live owner
identity. Directory writes, source Collection writes, session effects and both
owners' audit receipts commit atomically. Commands participate in the existing
transaction plan in call order; membership publication can see the preceding
account write. A failure in any command rolls back the whole transaction even if
Action planning code attempted to catch it.

```ts
const identity = await context.authentication.verify("oidc", { code });
await context.transaction(async (tx) => {
  await tx.directory.command("prepare", { accountId: identity.principal }, {
    operationKey: "prepare",
  });
  await tx.collections.accounts.create({ id: identity.principal });
  await tx.directory.command("publishMembership", {
    accountId: identity.principal,
  }, { operationKey: "publish" });
  await tx.sessions.create({ principal: identity.principal, maxAge: 3600 });
}, { operationKey: "complete-login" });
```

Transactional commands return no result because workers stage their plans.
Derive the account ID from verified evidence before planning. A standalone
`context.directory.command` can return a bounded result, but commits its own
transaction; it cannot promise atomicity with later calls. Reuse of a command
key in the same accepted Action invocation returns its retained result; changed
input/revision refuses. Private receipts retain results for replay, while
`directory.audit` contains coordinates and input/output digests only. Opposing
cross-schema lock orders may cause a database deadlock and rollback; commands
must have no effects outside their SQL transaction.

## Native Collections inside directory commands

Declare destination **composition aliases** and exact native methods in
`collections`. The owner supplies the registered destination Collection runtime;
application code does not construct a runtime or a `CommandContext`. Exactly one
attached destination composition must provide all declared aliases; it must also
bind their owner policies. Multiple matching compositions refuse. Closing a
composition removes its registration.

```ts
const publishMembership = defineDatabaseDirectoryCommand({
  databaseSchema: "directory",
  namespace: "directory",
  command: "publishMembership",
  revision: "1",
  actions: ["loginCallback"],
  evidence: ["oidc"],
  collections: {
    loginIndex: ["get", "create", "addMembership"],
    tenantRoute: ["create"],
  },
  async authorize({ authority, input, evidence }) {
    const identity = await evidence.get("oidc");
    return admittedSourceTenant(authority.scope.tenant) &&
      identity?.principal === parseDirectoryInput(input).accountId;
  },
  async execute({ collections, authority, evidence, transaction }) {
    const identity = requireVerifiedIdentity(await evidence.get("oidc"));
    const subjectId = identityKey(identity.issuer, identity.subject);
    // These application helpers read trusted state in the joined transaction.
    await requireActiveSourceAccount(transaction, identity.principal);
    const route = await requireProvisionedRoute(transaction, authority.scope);
    const existing = await collections.loginIndex.get({ id: subjectId });
    if (!existing) {
      await collections.loginIndex.create({
        id: subjectId,
        subject: identity.subject,
        members: [],
      });
    }
    await collections.loginIndex.commands.addMembership({
      id: subjectId,
      member: identity.principal,
    });
    // Route activation is allowed only after host-owned physical provisioning.
    await collections.tenantRoute.create({
      id: route.id,
      active: true,
      databaseSchema: route.databaseSchema,
    });
    return { accountId: identity.principal };
  },
});
```

`get({ id })`, `create(input)` and `commands.name({ id, ...input })` keep the
native Collection shapes. Mutations return planned mutation references. They run
the destination's schema validation, custom command reduction, event creation
and indexes. No write options or placement overrides are accepted. Undeclared
aliases/methods, missing destination policy registrations and expired repository
handles refuse. A caught repository refusal or unawaited failed call still
aborts the transaction. Captured app handles remain unavailable.

The destination must independently bind these Collections to its own registered
owner policies. For delegated calls, policy receives `directory` with the fixed
`command`, `databaseSchema` and `namespace`, alongside the **unchanged source**
`authority` and `intent.invocation`. Declared policy reads select fresh records
in the destination namespace. The source flow/session is validated by its own
owner; it is never treated as a credential for the destination. For example:

```ts
// Destination Collection policy excerpt, separate from subscription/read grants.
evaluate({ authority, intent, directory }) {
  if (
    directory?.command !== "publishMembership" ||
    !admittedSourceTenant(authority.scope.tenant) ||
    intent.invocation?.id !== loginCallback.id
  ) return {};
  return {
    collections: { loginIndex: {}, tenantRoute: {} },
    collectionMutations: {
      loginIndex: {
        create: { fields: ["subject", "members"] },
        commands: { addMembership: { fields: ["member"] } },
      },
      tenantRoute: { create: { fields: ["active", "databaseSchema"] } },
    },
  };
}
```

All three gates apply: the source directory grant, the declaration's destination
`authorize`, and the destination Collection policy. They remain effective at the
outer transaction's result gate. No directory grant becomes host trust or an
authority for subsequent detached work.

The destination joins the source transaction using its own live epoch and
command context. Rollback removes both schemas' records, native events, indexes,
session effects and receipts. After confirmed commit, destination subscription
updates and Processor deliveries use the destination owner/coordinator and
publication queue, including its fencing and shutdown drain. Processors receive
the original caller provenance; publication grants no additional mutation or
credential authority.

Replay returns the retained result without rerunning reducers or publishing
again. It rechecks source and destination authorization, including the retained
native intents against current destination policy and records. Private native
intent receipts are bounded to 1 MiB; command inputs/results remain bounded to
16 KiB. Audit receipts contain coordinates, method declarations and digests,
never Collection payloads. Protect and retain private receipt storage under the
same policy as private directory results. Changes to method declarations require
a new command revision and conflict with an existing operation's replay intent.

## Flow-bounded Processor projections

A Processor may read or mutate Collections for a flow only when its live,
owner-retained delivery points to an event committed in that flow's consumed
operation. Product policy must additionally grant
`flowProcessors: ["records.project"]` using the Processor's stable ID, along
with exact Collection grants. Policy receives `intent.invocation` and should
validate proposed projections against fresh declared sources.

This also permits detached processing of an event committed in the consumed
operation. It does not authorize a further event emitted in the detached
Processor's separate operation. Such an event cannot extend the flow, even when
its metadata claims the original ancestry. Processors cannot use flow authority
to start unrelated operations, invoke child Actions, mint sessions or flows,
verify identities or call directory commands. Expiry, client proof, current
delivery lease and owner epoch remain enforced. A remote Processor has the same
retained invocation around its owner RPCs as an in-process handler.
