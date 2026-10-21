---
title: "Chapter 16: Authenticate and Isolate Tenants"
description: "Map a host-verified principal to a trusted tenant, keep membership and roles as owner data, and let one versioned policy decide each request instead of trusting identity or route exposure alone."
section: Getting Started
order: 160
status: stable
---

# Chapter 16: Authenticate and Isolate Tenants

> Part 4 — Release to Users · Track: R · Requires: Chapters 6 and 15 · Needs:
> Deno 2.9+ or Node 24+ (no credential, no model provider)

## The pain

Chapter 15 put `notes.save` behind HTTP with one fixed token, one local identity
and a policy that grants every authenticated caller everything. That is enough
for one person on one machine. It stops being enough the moment a second person
or a second customer uses the API.

With that policy, every caller who passes the credential check can do everything
the facade offers. Ada can read the result of Grace's operation if she learns
its ID, and cancel it. A caller who should only read status can still save
notes. And nothing yet shows that a second customer, working in its own
namespace, cannot reach the first customer's operations, even when it puts the
other namespace in a query string.

## The problem

Three separate questions hide behind "is this request allowed?":

- **Who is calling?** That is identity. The host answers it by verifying a
  session, token or certificate it already trusts.
- **Which tenant and owner does the request act for?** That is scope. It must
  come from the verified identity, never from the request body, query string or
  a header the caller controls.
- **May this caller do this specific thing?** That is authorization. Knowing who
  someone is does not decide which Actions they may run or which operations they
  may inspect, and the answer can change while they are signed in.

Route exposure answers none of these. `expose` decides which routes exist; a
policy decides who may use them. A recorded actor ID does not enforce anything
by itself either: it is a fact on the operation, not a rule about who may read
it.

## The solution

Split the boundary into pure pieces, and keep the verification itself in the
host:

1. The host's **principal resolver** verifies the request and returns a
   `Principal`: the actor, the tenant namespace and an optional database schema.
   Production hosts plug in the session or token verification they already have.
   This chapter does not implement JWT or signature checks.
2. `principalScope(principal, context, policy)` turns that principal into the
   facade's trusted **scope** and its **authority binding**, as Chapter 15 did
   inside `server.ts`. `authenticate` returns it, so the server reads the
   namespace and schema from the principal only.
3. A `member` Collection holds each tenant's **memberships**: which actors
   belong to it and with which roles. It is ordinary owner data. The host writes
   it with trusted host calls; no route exposes it.
4. `notesAccess` is the **policy**, revision `2`. It declares `member` as its
   only source, and the owner evaluates it inside every command a request
   starts:
   - **Not a member of the request's tenant:** nothing is granted.
   - **Action intents:** `saveNote` only for members with the `editor` role.
     Anyone else gets `403` before anything is admitted.
   - **Everything else**, such as operation status, result, cancel and observe:
     the constraint `operations.metadata: { initiatorUserId }`. Admission stamps
     each new operation with its initiator, and the server treats an operation
     whose metadata does not match as not found, so one actor cannot inspect or
     cancel another actor's operation in the same tenant.
   - Assets, sessions and anything else the policy does not name stay refused.

The policy changed what it grants, so its revision moves from `1` to `2`. A
binding names the exact revision it was minted for, and the owner refuses a
revision it no longer knows. Because the policy reads membership inside each
command, granting or removing a role applies to the caller's next request,
without a new sign-in.

Two scopes are worth keeping apart:

- **`namespace` is the semantic tenant.** Records, Events, operations and
  memberships are partitioned by it. Two tenants can share one database, and an
  operation ID from one namespace does not resolve in another.
- **`databaseSchema` is a physical scope.** A host that gives each tenant its
  own database schema sets it on the principal; most hosts leave it out and use
  the application's default schema.

Namespace isolation is not a per-record access list. Inside one tenant, every
editor writes to the same `note` Collection, and the `note` schema has no owner
field. This chapter protects **operations** per actor, not individual notes. If
notes need per-user ownership, that is a schema decision (an owner field, set
from trusted data) plus a binding for `note` whose policy returns read filters
(`collections`) and write grants (`collectionMutations`). This Action-only
application keeps Collection routes disabled, and `notes.save`'s own validation
owns the write.

Text in a prompt or request is not authorization either. Nothing a caller sends
in the body, query string or metadata can set the trusted actor, namespace,
schema, membership or authority; only the resolver's principal and the owner's
data do.

### Create `auth.ts`

`auth.ts` is a **definition module**: types, the `member` Collection, the policy
and two functions. It performs no I/O at import time and reads no credential.
`grantRoles` performs I/O only when host code calls it.

```ts
// Runtime helpers: the admission-lifetime helper and the Collection definer.
import { credentialValidity, defineCollection } from "@copilotz/copilotz";
// Types of the authority binding, the owner policy and the application.
import type {
  AuthenticatedAuthority,
  AuthorityPolicy,
  CopilotzApplication,
  OwnerAuthorization,
} from "@copilotz/copilotz";
// Types of the facade's authentication context and the scope it returns.
import type {
  ServerAuthenticationContext,
  ServerAuthorizedScope,
} from "@copilotz/copilotz/server";

// A caller the host has already verified. The server copies these values into
// the request scope; it never reads identity or tenant from the request.
export type Principal = Readonly<{
  // Stable ID of the acting user. Also the owner of the operations they start.
  actorId: string;
  // Semantic tenant. Records, Events and operations are scoped to it.
  namespace: string;
  // Optional physical database schema for hosts that separate tenants by schema.
  databaseSchema?: string;
}>;

// Who belongs to a tenant, and what they may do there. The owner reads this
// Collection while it evaluates the policy, so a change applies to the next
// command without a new sign-in.
export const member = defineCollection({
  name: "member",
  schema: {
    type: "object",
    properties: {
      // Record identity, generated by the runtime.
      id: { type: "string", readOnly: true },
      // The member's actor ID.
      actorId: { type: "string" },
      // Roles granted in this tenant, such as `editor`.
      roles: { type: "array", items: { type: "string" } },
    },
    required: ["actorId", "roles"],
  } as const,
  // One membership per actor in each tenant.
  indexes: [{ fields: ["actorId"], unique: true }],
});

// One host's authorization: the policy its requests are evaluated under, and
// the registration the owner evaluates.
export type Access = Readonly<{
  policy: AuthorityPolicy;
  authorization: OwnerAuthorization;
}>;

// The policy every request is evaluated under. Change the revision whenever
// `evaluate` grants something different.
const notesPolicy = { id: "notes", revision: "2" } as const;

// Owner-evaluated authorization for the Notes API.
export const notesAccess: Access = {
  policy: notesPolicy,
  authorization: {
    policies: {
      [notesPolicy.id]: {
        revision: notesPolicy.revision,
        // The only data this policy may read.
        sources: ["member"],
        async evaluate({ authority, intent, read }) {
          // Membership in the request's tenant, read inside the command.
          const [membership] = await read.list("member", {
            where: { actorId: authority.principal.id },
            limit: 1,
          });
          // Not a member of this tenant: nothing is granted.
          if (!membership) return {};
          // Admission stamps each operation with its initiator; only that
          // initiator can then read, observe or cancel it.
          const ownOperations = {
            operations: {
              metadata: { initiatorUserId: authority.principal.id },
            },
          };
          // Action intents name the Action by its alias. Only editors save.
          if (intent.kind === "action") {
            const roles = membership.roles as string[];
            return roles.includes("editor")
              ? { ...ownOperations, actions: { saveNote: {} } }
              : {};
          }
          // Operation reads, observation and cancellation.
          return ownOperations;
        },
      },
    },
    // Every exposed Action needs a binding, keyed by its alias, to a policy.
    actions: { saveNote: notesPolicy },
    // No Collection is exposed.
    collections: {},
  },
};

// Turns a verified principal into the facade's trusted scope, including the
// authority binding the owner evaluates for every command the request runs.
export function principalScope(
  principal: Principal,
  context: ServerAuthenticationContext,
  policy: AuthorityPolicy,
): ServerAuthorizedScope {
  const databaseSchema = principal.databaseSchema ??
    context.defaultDatabaseSchema;
  const authority: AuthenticatedAuthority = {
    version: 1,
    // The verified credential holder. Policies see this, never the request.
    principal: { kind: "api-key", id: principal.actorId },
    // The tenant and physical schema the binding is valid in.
    scope: {
      owner: "schema",
      databaseSchema,
      tenant: principal.namespace,
      namespace: principal.namespace,
      bindings: {},
    },
    // A 15-minute admission, renewed when the client authenticates again.
    validity: credentialValidity(new Date()),
    policy,
    // The facade fills in the matched endpoint, operation and parameters.
    requestFacts: {
      endpoint: context.endpoint.key,
      transport: "http",
      operation: context.endpoint.operation ?? context.endpoint.kind,
      params: context.params,
      input: null,
    },
    provenance: { ingress: "http", source: context.endpoint.key },
    dependencies: [],
    // What the authority rests on: here, the caller's own credential.
    authorityBasis: { kind: "credential", id: principal.actorId },
  };
  return {
    actor: { id: principal.actorId },
    namespace: principal.namespace,
    databaseSchema,
    authority,
  };
}

// Gives an actor exactly these roles in a tenant, creating or replacing its
// membership. Host code only: trusted host calls run without a policy.
export async function grantRoles(
  app: Pick<CopilotzApplication, "collections">,
  actorId: string,
  roles: readonly string[],
  options: Readonly<{ namespace?: string }> = {},
): Promise<void> {
  const [current] = await app.collections.member.list({
    where: { actorId },
    limit: 1,
  }, options);
  if (current) {
    await app.collections.member.update({
      id: current.id,
      set: { roles: [...roles] },
    }, options);
  } else {
    await app.collections.member.create(
      { actorId, roles: [...roles] },
      options,
    );
  }
}
```

Membership records get generated IDs and an `actorId` field instead of using the
actor ID as the record ID. Record IDs are unique across every Collection and
namespace of one database schema, so the same actor in two tenants would
otherwise collide.

`grantRoles` uses `app.collections`, the trusted host surface. Host calls run
without a policy, which is what seeding and administration need; that is also
why only host code may call it.

### Replace `server.ts`

Replace `server.ts` with this complete file. It now imports `member`,
`notesAccess` and `principalScope` from `auth.ts`, re-exports the `Principal`
type so the hosts keep their import, composes `member` as a Collection, passes
`notesAccess.authorization` to `createCopilotz`, and returns
`principalScope(principal, context, notesAccess.policy)` from `authenticate`.
Host options, `serverPlugins`, `publicActions` and the explicit exposure are
unchanged, and the module still imports no Core, composition, environment or MCP
module.

```ts
// Runtime factory, plus the public type of every accepted database choice.
import { createCopilotz } from "@copilotz/copilotz";
import type { CopilotzDatabaseInput } from "@copilotz/copilotz";
// The Fetch boundary: its plugin, the facade declaration and the
// authentication callback type.
import { defineServerFacade, serverPlugin } from "@copilotz/copilotz/server";
import type { ServerAuthenticate } from "@copilotz/copilotz/server";
// Membership, the owner policy and the principal-to-scope mapping.
import { member, notesAccess, principalScope } from "./auth.ts";
import type { Principal } from "./auth.ts";
// The reusable Notes package that owns `notes.save`.
import { notesPlugin } from "./notes-plugin.ts";

// Hosts and tests keep importing the principal type from here.
export type { Principal } from "./auth.ts";

// Host-supplied verification. It returns the trusted principal, or
// `undefined` when the request carries no acceptable credential.
export type ResolvePrincipal = (
  request: Request,
) => Principal | undefined | Promise<Principal | undefined>;

// Choices only the host can make. Nothing here has a persistent default.
export type ServerAppOptions = Readonly<{
  // Verifies each request. Required, so no facade is ever built without it.
  resolvePrincipal: ResolvePrincipal;
  // Default namespace for the application. Defaults to `team-notes`.
  namespace?: string;
  // Database chosen by the host. Omit it for a private in-memory database.
  database?: CopilotzDatabaseInput;
}>;

// The only Action aliases the facade publishes. Adding a plugin later does not
// add routes until its Action's alias is listed here.
export const publicActions = ["saveNote"];

// Plugins the server application composes: the Notes package and the facade.
export const serverPlugins = [notesPlugin, serverPlugin];

// Builds the Notes application with its HTTP boundary. The returned app's
// `fetch` method is the handler a host serves.
export function createServerApp(options: ServerAppOptions) {
  // Turns the host's principal into the facade's trusted scope, or rejects.
  const authenticate: ServerAuthenticate = async (request, context) => {
    const principal = await options.resolvePrincipal(request);
    // No verified principal: refuse before any route runs.
    if (!principal) {
      return Response.json(
        {
          error: { code: "unauthorized", message: "Authentication required." },
        },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    // Tenant, schema, actor and authority come only from the principal.
    return principalScope(principal, context, notesAccess.policy);
  };

  return createCopilotz({
    // The application's default tenant, chosen by the host.
    namespace: options.namespace ?? "team-notes",
    // Pass the host's database through only when it chose one.
    ...(options.database ? { database: options.database } : {}),
    plugins: serverPlugins,
    // Policy data: the owner reads it, the facade never exposes it.
    collections: { member },
    // Evaluated by the owner inside every command a request starts.
    authorization: notesAccess.authorization,
    resources: {
      server: {
        // The facade served at `/api`.
        default: defineServerFacade({
          // Explicit allowlist. Without it, every Action, Collection read and
          // Channel would be exposed.
          expose: {
            actions: { include: publicActions },
            // Notes and memberships stay off raw Collection routes.
            collections: false,
            // Notes has no Channels to publish.
            channels: false,
          },
          // Runs for every matched facade route, including fixed routes.
          authenticate,
        }),
      },
    },
  });
}
```

`expose` and the policy stay separate on purpose. `expose` keeps `saveNote` the
only Action route even after you add plugins; the policy decides which
principals may call it, and `collections: false` keeps the memberships off HTTP.

### Update the hosts

`Principal` is unchanged, but the local demo identity now needs a membership. In
**`serve.ts`** and in **`serve-node.ts`**, add this import below the
`./server.ts` imports:

```ts
// The host helper that writes memberships.
import { grantRoles } from "./auth.ts";
```

Then insert this statement as the first line inside the `try` block, before the
listener starts:

```ts
// The local demo identity may save notes. A trusted host call, so it runs
// without a policy; repeating it on the next start changes nothing.
await grantRoles(app, localUser.actorId, ["editor"]);
```

Everything else in both hosts stays the same: the fixed loopback development
token, the composition's namespace and database, and the shutdown handling. A
production host replaces the `resolvePrincipal` function with its existing
session or token verification, maps the verified user to a `Principal`, and
manages memberships from its own administration flow; this chapter does not wire
an identity provider. `call-notes.ts` is unchanged: same URL, same token, same
idempotency key, and it still prints no credential.

### Create `server.scenarios.ts`

The scenarios exercise the boundary through `app.fetch` only, using the public
client with an injected `fetch`, so no listener and no network are involved.
Each scenario builds its own application without `database`, so it gets a
private in-memory database, writes the fixture memberships, and closes the app
in `finally`.

The fixture resolver maps fixed test tokens to app-owned test principals. It is
a test double for the host's verification, **not** a production authentication
scheme. It reads no environment variable and calls no identity service.

```ts
// Node's strict assertions work on both Deno and Node.
import assert from "node:assert/strict";
// The public HTTP client and its error type.
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "@copilotz/copilotz/client";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";
// The host helper that writes memberships.
import { grantRoles } from "./auth.ts";

// Test-only principals, keyed by fixed test tokens. Ada and Grace share
// tenant A; Bea works in tenant B; Viv is in tenant A.
const fixturePrincipals = new Map<string, Principal>([
  ["token-ada", { actorId: "ada", namespace: "tenant-a" }],
  ["token-grace", { actorId: "grace", namespace: "tenant-a" }],
  ["token-bea", { actorId: "bea", namespace: "tenant-b" }],
  ["token-viv", { actorId: "viv", namespace: "tenant-a" }],
]);

// Test-only memberships, written by the trusted host before each scenario.
// Viv is a member of tenant A without the editor role.
const fixtureMembers = [
  { namespace: "tenant-a", actorId: "ada", roles: ["editor"] },
  { namespace: "tenant-a", actorId: "grace", roles: ["editor"] },
  { namespace: "tenant-b", actorId: "bea", roles: ["editor"] },
  { namespace: "tenant-a", actorId: "viv", roles: [] },
];

// Stands in for the host's verification: exact bearer token lookup only.
function fixtureResolver(request: Request): Principal | undefined {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ")
    ? fixturePrincipals.get(header.slice("Bearer ".length))
    : undefined;
}

type ServerApp = Awaited<ReturnType<typeof createServerApp>>;

// Builds a private in-memory app, runs one scenario, and always closes it.
async function withApp(run: (app: ServerApp) => Promise<void>) {
  const app = await createServerApp({ resolvePrincipal: fixtureResolver });
  try {
    // Trusted host calls: they run without a policy.
    for (const { namespace, actorId, roles } of fixtureMembers) {
      await grantRoles(app, actorId, roles, { namespace });
    }
    await run(app);
  } finally {
    await app.close();
  }
}

// A client whose requests go straight to `app.fetch`, with an optional token.
function clientFor(app: ServerApp, token?: string) {
  return createCopilotzClient({
    baseUrl: "http://notes.test/api",
    fetch: (input, init) => app.fetch(new Request(input, init)),
    ...(token
      ? { getRequestHeaders: () => ({ authorization: `Bearer ${token}` }) }
      : {}),
  });
}

// Runs a request that must fail and returns its HTTP status.
async function rejectedStatus(
  request: () => Promise<unknown>,
): Promise<number> {
  try {
    await request();
  } catch (error) {
    if (error instanceof CopilotzHttpError) return error.status;
    throw error;
  }
  assert.fail("Expected the request to be rejected.");
}

// Reads the saved note's `id` and `text` from an operation result.
function noteOf(output: unknown): { id: unknown; text: unknown } {
  const note = (output ?? {}) as Record<string, unknown>;
  return { id: note.id, text: note.text };
}

export const serverScenarios = {
  // Missing or unknown credentials get 401 and admit nothing.
  "rejects missing and wrong credentials": () =>
    withApp(async (app) => {
      for (const client of [clientFor(app), clientFor(app, "token-mallory")]) {
        assert.equal(
          await rejectedStatus(() =>
            client.actions.submit("saveNote", { text: "Intruder." }, {
              idempotencyKey: "auth-1",
            })
          ),
          401,
        );
      }
      // The key was never admitted: Ada can use it for different text.
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("saveNote", {
        text: "Mine.",
      }, { idempotencyKey: "auth-1" });
      assert.equal(
        noteOf((await ada.operations.result(receipt.operationId)).value).text,
        "Mine.",
      );
    }),

  // An allowed principal saves a note and reads its own result.
  "owner reads its own result": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("saveNote", {
        text: "Plan the launch.",
      }, { idempotencyKey: "own-1" });
      assert.equal(
        noteOf((await ada.operations.result(receipt.operationId)).value).text,
        "Plan the launch.",
      );
    }),

  // Same key and input is one operation; same key with new input is a conflict.
  "idempotency key maps to one submission": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const first = await ada.actions.submit("saveNote", {
        text: "Once.",
      }, { idempotencyKey: "retry-1" });
      const retry = await ada.actions.submit("saveNote", {
        text: "Once.",
      }, { idempotencyKey: "retry-1" });
      assert.equal(retry.operationId, first.operationId);
      assert.equal(
        noteOf((await ada.operations.result(retry.operationId)).value).id,
        noteOf((await ada.operations.result(first.operationId)).value).id,
      );
      assert.equal(
        await rejectedStatus(() =>
          ada.actions.submit("saveNote", { text: "Twice." }, {
            idempotencyKey: "retry-1",
          })
        ),
        409,
      );
    }),

  // Another tenant cannot see the operation, even with its ID.
  "other tenant cannot read the operation": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const bea = clientFor(app, "token-bea");
      const receipt = await ada.actions.submit("saveNote", {
        text: "Tenant A only.",
      }, { idempotencyKey: "tenant-1" });
      await ada.operations.result(receipt.operationId);
      assert.equal(
        await rejectedStatus(() => bea.operations.get(receipt.operationId)),
        404,
      );
      assert.equal(
        await rejectedStatus(() => bea.operations.result(receipt.operationId)),
        404,
      );
    }),

  // Same tenant, different actor: ownership hides the operation.
  "other actor cannot read or cancel the operation": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const grace = clientFor(app, "token-grace");
      const receipt = await ada.actions.submit("saveNote", {
        text: "Ada's draft.",
      }, { idempotencyKey: "owner-1" });
      assert.equal(
        await rejectedStatus(() => grace.operations.get(receipt.operationId)),
        404,
      );
      assert.equal(
        await rejectedStatus(() =>
          grace.operations.result(receipt.operationId)
        ),
        404,
      );
      assert.equal(
        await rejectedStatus(() =>
          grace.operations.cancel(receipt.operationId)
        ),
        404,
      );
      // Reusing Ada's key and text is a conflict, not access to her operation.
      assert.equal(
        await rejectedStatus(() =>
          grace.actions.submit("saveNote", { text: "Ada's draft." }, {
            idempotencyKey: "owner-1",
          })
        ),
        409,
      );
      // Ada still owns an intact result.
      assert.equal(
        noteOf((await ada.operations.result(receipt.operationId)).value).text,
        "Ada's draft.",
      );
    }),

  // A member without the editor role gets 403 and admits nothing.
  "a member without the editor role cannot save": () =>
    withApp(async (app) => {
      const viv = clientFor(app, "token-viv");
      assert.equal(
        await rejectedStatus(() =>
          viv.actions.submit("saveNote", { text: "Not allowed." }, {
            idempotencyKey: "deny-1",
          })
        ),
        403,
      );
      // Nothing was admitted in tenant A under that key.
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("saveNote", {
        text: "Allowed.",
      }, { idempotencyKey: "deny-1" });
      assert.equal(
        noteOf((await ada.operations.result(receipt.operationId)).value).text,
        "Allowed.",
      );
    }),

  // Membership is owner data: a change applies to the next request.
  "a membership change applies to the next request": () =>
    withApp(async (app) => {
      const viv = clientFor(app, "token-viv");
      assert.equal(
        await rejectedStatus(() =>
          viv.actions.submit("saveNote", { text: "Not yet." }, {
            idempotencyKey: "promote-1",
          })
        ),
        403,
      );
      // The trusted host grants the role. Viv's credential does not change.
      await grantRoles(app, "viv", ["editor"], { namespace: "tenant-a" });
      const receipt = await viv.actions.submit("saveNote", {
        text: "Now I can.",
      }, { idempotencyKey: "promote-2" });
      assert.equal(
        noteOf(await viv.operations.result(receipt.operationId)).text,
        "Now I can.",
      );
    }),

  // A namespace in the query string or a header does not choose the tenant.
  "request cannot choose its tenant": () =>
    withApp(async (app) => {
      const response = await app.fetch(
        new Request(
          "http://notes.test/api/actions/saveNote?namespace=tenant-b",
          {
            method: "POST",
            headers: {
              authorization: "Bearer token-ada",
              "content-type": "application/json",
              "idempotency-key": "spoof-1",
              "x-namespace": "tenant-b",
            },
            body: JSON.stringify({ text: "Where am I?" }),
          },
        ),
      );
      assert.equal(response.status, 202);
      const { operationId } = (await response.json()).data;
      // The operation lives in Ada's trusted tenant, not the requested one.
      const ada = clientFor(app, "token-ada");
      assert.equal(
        noteOf((await ada.operations.result(operationId)).value).text,
        "Where am I?",
      );
      assert.equal(
        await rejectedStatus(() =>
          clientFor(app, "token-bea").operations.get(operationId)
        ),
        404,
      );
    }),
};
```

The spoof scenario sends a `namespace` query parameter and a made-up
`x-namespace` header, neither of which the facade reads, and keeps the body
valid. Putting a `namespace` field in the body would fail `notes.save`'s input
schema with a 400, which would prove nothing about tenant isolation.

The membership scenario changes Viv's roles with a host call between two
requests made with the same token. The second request is admitted because the
owner reads the current membership inside that command.

Idempotency keys are scoped to the tenant, so two callers in one tenant can
collide on a key. If Grace reuses Ada's key with the same text, she gets
`409 idempotency_conflict`. She does not get Ada's operation, and its result is
still hidden from her. To avoid collisions, production callers should create one
unique, stable key per logical submission (for example, a UUID stored with the
submission). Reusing someone else's key never grants access to their operation.

### Create `server.test.ts`

```ts
// The shared scenarios. Every check lives there.
import { serverScenarios } from "./server.scenarios.ts";

// One Deno test per scenario, named after it.
for (const [name, scenario] of Object.entries(serverScenarios)) {
  Deno.test(`Server: ${name}`, scenario);
}
```

### Create `server.node-test.ts`

```ts
// Node's built-in test runner.
import { test } from "node:test";
// The same shared scenarios that `server.test.ts` registers with Deno.
import { serverScenarios } from "./server.scenarios.ts";

// One Node test per scenario, named after it.
for (const [name, scenario] of Object.entries(serverScenarios)) {
  test(`Server: ${name}`, scenario);
}
```

## Check it works

Run the scenarios with either runtime:

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno test -A server.test.ts
# Node 24+: the same scenarios through node:test.
node --test server.node-test.ts
```

Both runners report **8 passed** and 0 failed. The tests check statuses and
results, not exact error messages or generated IDs.

Then confirm the local host still works with its new membership. Start
`serve.ts` (or `serve-node.ts`) as in Chapter 15 and run the client with a fresh
key:

```sh
# Deno client against the running host.
deno run --allow-net=127.0.0.1:8000 call-notes.ts "Isolate tenants." note-016
```

It prints an `operation …` line and `saved note=… text="Isolate tenants."`,
because the local identity is an editor and the client reads only operations it
started. Stop the host with Ctrl+C. Starting it again keeps the same membership.

## What this unlocks

- One deployment can serve many tenants and users: the namespace and the
  operation owner come from the verified principal, so a forged query string or
  header cannot move a request into another tenant.
- Roles as data: granting or removing `editor` takes effect on the next request,
  evaluated by the owner in the transaction that does the work.
- Operation privacy inside a tenant: status, results, observation and
  cancellation only reach the actor who started the operation.
- A default-deny posture: anything the policy does not name, including Assets,
  sessions and Collections, stays closed.
- Replacing the development token with real sign-in changes only the host's
  resolver; `auth.ts`, `server.ts` and the tests stay as they are.

## Next steps

- Next (Agent Harness, optional, requires Chapters 8 and 16):
  [Chapter 17: Connect Chat and Channels](17-connect-chat-and-channels.md) puts
  the assistant behind this authenticated boundary.
- Runtime track:
  [Chapter 18: Handle Files and Large Content](18-handle-files-and-large-content.md)
  adds file bodies and scoped Asset references without putting bytes in ingress
  Events.
- Reference: [Owner authorization](../../authorization.md) lists every
  constraint a policy can return, sessions and credential lifetimes.
- Reference: [HTTP server and browser client](../../server.md) lists endpoint
  kinds and scope fields.
- Reference: [Testing and inspection](../../testing-and-inspection.md) covers
  scenario tests against `app.fetch`.
