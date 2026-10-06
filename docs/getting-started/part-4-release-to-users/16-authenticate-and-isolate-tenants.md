---
title: "Chapter 16: Authenticate and Isolate Tenants"
description: "Map a host-verified principal to a trusted tenant and operation owner, and authorize each request explicitly instead of trusting identity or route exposure alone."
section: Getting Started
order: 160
status: stable
---

# Chapter 16: Authenticate and Isolate Tenants

> Part 4 — Release to Users · Track: R · Requires: Chapters 6 and 15 · Needs:
> Deno 2.9+ or Node 24+ (no credential, no model provider)

## The pain

Chapter 15 put `notes.save` behind HTTP with one fixed token and one local
identity. That is enough for one person on one machine. It stops being enough
the moment a second person or a second customer uses the API.

With only `authenticate`, every caller who passes the credential check can do
everything the facade offers. Ada can read the result of Grace's operation if
she learns its ID, and cancel it. A caller who should only read status can still
save notes. And nothing yet shows that a second customer, working in its own
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
  may inspect.

Route exposure answers none of these. `expose` decides which routes exist;
everyone who authenticates can call every route that exists, unless a policy
says otherwise. A recorded actor ID does not enforce anything by itself either:
it is a fact on the operation, not a rule about who may read it.

## The solution

Split the boundary into two pure pieces, and keep the verification itself in the
host:

1. The host's **principal resolver** verifies the request and returns a
   `Principal`: the actor, the tenant namespace, an optional database schema and
   the Action IDs this principal may run. Production hosts plug in the session
   or token verification they already have. This chapter does not implement JWT
   or signature checks.
2. `principalScope(principal)` turns that principal into the facade's trusted
   **scope**. `authenticate` returns it, so the server reads the namespace and
   schema from the principal only. The scope also records an app-owned ownership
   claim, `initiatorUserId`, as **operation metadata** on every operation the
   principal starts.
3. `authorizeRequest` is the facade's `authorize` callback. It runs after
   authentication on every matched route and decides per endpoint kind:
   - **Action routes** pass only if the endpoint's stable Action ID is in the
     principal's `allowedActionIds`. Otherwise it returns `403` before anything
     is admitted.
   - **Operation routes** (status, result, cancel, observe) return the
     constraint `operations.metadata: { initiatorUserId }`. The server then
     treats an operation whose metadata does not match as not found, so one
     actor cannot inspect or cancel another actor's operation in the same
     tenant.
   - **The OpenAPI document** is allowed for any authenticated caller. It only
     describes the routes this facade exposes; it reads no tenant data.
   - **Everything else is denied**: Asset, Collection, Channel, agent and custom
     HTTP routes. This application keeps Collections and Channels unexposed
     already, but the fixed Asset routes still exist. Each of those families
     gets its own policy when a later chapter needs it.

Two scopes are worth keeping apart:

- **`namespace` is the semantic tenant.** Records, Events and operations are
  partitioned by it. Two tenants can share one database, and an operation ID
  from one namespace does not resolve in another.
- **`databaseSchema` is a physical scope.** A host that gives each tenant its
  own database schema sets it on the principal; most hosts leave it out and use
  the application's default schema.

Namespace isolation is not a per-record access list. Inside one tenant, every
principal allowed to run `notes.save` writes to the same `note` Collection, and
the `note` schema has no owner field. This chapter protects **operations** per
actor, not individual notes. If notes need per-user ownership, that is a schema
decision (an owner field, set from trusted data) plus Collection read filters,
which are a separate `collections` constraint from the `collectionMutations`
write policy. This Action-only application keeps Collection routes disabled, and
`notes.save`'s own validation owns the write.

Text in a prompt or request is not authorization either. Nothing a caller sends
in the body, query string or metadata can set the trusted actor, namespace,
schema or ownership claim; only the resolver's principal does.

### Create `auth.ts`

`auth.ts` is a **definition module**: types and two pure functions, no I/O and
no credential. It imports only types from the public server entrypoint.

```ts
// Public types for the facade's trusted scope and its authorization callback.
import type {
  ServerAuthorize,
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
  // Stable Action IDs this principal may run over HTTP.
  allowedActionIds: readonly string[];
}>;

// Turns a verified principal into the facade's trusted scope.
export function principalScope(principal: Principal): ServerAuthorizedScope {
  return {
    actor: { id: principal.actorId },
    namespace: principal.namespace,
    ...(principal.databaseSchema
      ? { databaseSchema: principal.databaseSchema }
      : {}),
    // App-owned ownership claim, recorded on every operation this request
    // starts and matched again on every operation read or cancel.
    operationMetadata: { initiatorUserId: principal.actorId },
    // Host policy data for `authorizeRequest`; not caller input.
    context: { allowedActionIds: [...principal.allowedActionIds] },
  };
}

// A JSON 403 in the facade's error shape.
function forbidden(message: string): Response {
  return Response.json(
    { error: { code: "forbidden", message } },
    { status: 403 },
  );
}

// Per-request authorization. Runs after `authenticate` on every matched route.
export const authorizeRequest: ServerAuthorize = (
  _request,
  { endpoint, scope },
) => {
  const owner = scope.operationMetadata?.initiatorUserId;
  // Without a trusted owner there is nothing to constrain operations by.
  if (typeof owner !== "string" || !owner) {
    return forbidden("No trusted operation owner.");
  }
  // Every operation route only sees operations this actor started.
  const ownOperations = {
    operations: { metadata: { initiatorUserId: owner } },
  };

  switch (endpoint.kind) {
    case "action": {
      // `endpoint.id` is the stable Action ID, such as `notes.save`.
      const allowed = scope.context?.allowedActionIds;
      return Array.isArray(allowed) && allowed.includes(endpoint.id)
        ? ownOperations
        : forbidden("This Action is not allowed for the caller.");
    }
    case "operation":
      // Status, result, cancel and observe: owner-only.
      return ownOperations;
    case "openapi":
      // Route metadata only; it reads no tenant data.
      return {};
    default:
      // Assets, Collections, Channels, agents and custom routes have no
      // policy yet, so they are denied.
      return forbidden("This route is not available.");
  }
};
```

`allowedActionIds` lives on the principal because which Actions a user may run
is a host decision, like their tenant. Your host might derive it from roles it
already stores.

### Replace `server.ts`

Replace `server.ts` with this complete file. It now imports `Principal`,
`principalScope` and `authorizeRequest` from `auth.ts`, re-exports the
`Principal` type so the hosts keep their import, returns
`principalScope(principal)` from `authenticate`, and passes `authorizeRequest`
to the facade. Host options, `serverPlugins`, `publicActions` and the explicit
exposure are unchanged, and the module still imports no Core, composition,
environment or MCP module.

```ts
// Runtime factory, plus the public type of every accepted database choice.
import { createCopilotz } from "@copilotz/copilotz";
import type { CopilotzDatabaseInput } from "@copilotz/copilotz";
// The Fetch boundary: its plugin, the facade declaration and the
// authentication callback type.
import { defineServerFacade, serverPlugin } from "@copilotz/copilotz/server";
import type { ServerAuthenticate } from "@copilotz/copilotz/server";
// Trusted-principal policy: scope mapping and per-request authorization.
import { authorizeRequest, principalScope } from "./auth.ts";
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

// The only Action IDs the facade publishes. Adding a plugin later does not add
// routes until its Action is listed here.
export const publicActions = ["notes.save"];

// Plugins the server application composes: the Notes package and the facade.
export const serverPlugins = [notesPlugin, serverPlugin];

// Builds the Notes application with its HTTP boundary. The returned app's
// `fetch` method is the handler a host serves.
export function createServerApp(options: ServerAppOptions) {
  // Turns the host's principal into the facade's trusted scope, or rejects.
  const authenticate: ServerAuthenticate = async (request) => {
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
    // Tenant, schema, actor and owner come only from the verified principal.
    return principalScope(principal);
  };

  return createCopilotz({
    // The application's default tenant, chosen by the host.
    namespace: options.namespace ?? "team-notes",
    // Pass the host's database through only when it chose one.
    ...(options.database ? { database: options.database } : {}),
    plugins: serverPlugins,
    resources: {
      server: {
        // The facade served at `/api`.
        default: defineServerFacade({
          // Explicit allowlist. Without it, every Action, Collection read and
          // Channel would be exposed.
          expose: {
            actions: { include: publicActions },
            // Notes are written through `notes.save`, not raw Collection routes.
            collections: false,
            // Notes has no Channels to publish.
            channels: false,
          },
          // Runs for every matched facade route, including fixed routes.
          authenticate,
          // Decides, per route, what the authenticated principal may do.
          authorize: authorizeRequest,
        }),
      },
    },
  });
}
```

`expose` and `authorize` stay separate on purpose. `expose` keeps `notes.save`
the only Action route even after you add plugins; `authorize` decides which
principals may call it.

### Update the hosts

`Principal` now requires `allowedActionIds`, so both hosts need one change. In
**`serve.ts`** and in **`serve-node.ts`**, replace the `localUser` declaration
with:

```ts
// The one local demo identity this development host trusts. It may run only
// `notes.save`.
const localUser: Principal = {
  actorId: "local-guide-user",
  namespace,
  allowedActionIds: ["notes.save"],
};
```

Everything else in both hosts stays the same: the fixed loopback development
token, the composition's namespace and database, and the shutdown handling. A
production host replaces the `resolvePrincipal` function with its existing
session or token verification and maps the verified user to a `Principal`; this
chapter does not wire an identity provider. `call-notes.ts` is unchanged: same
URL, same token, same idempotency key, and it still prints no credential.

### Create `server.scenarios.ts`

The scenarios exercise the boundary through `app.fetch` only, using the public
client with an injected `fetch`, so no listener and no network are involved.
Each scenario builds its own application without `database`, so it gets a
private in-memory database, and closes it in `finally`.

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

// Test-only principals, keyed by fixed test tokens. Ada and Grace share
// tenant A; Bea works in tenant B; Viv is in tenant A but may run no Action.
const fixturePrincipals = new Map<string, Principal>([
  ["token-ada", {
    actorId: "ada",
    namespace: "tenant-a",
    allowedActionIds: ["notes.save"],
  }],
  ["token-grace", {
    actorId: "grace",
    namespace: "tenant-a",
    allowedActionIds: ["notes.save"],
  }],
  ["token-bea", {
    actorId: "bea",
    namespace: "tenant-b",
    allowedActionIds: ["notes.save"],
  }],
  ["token-viv", {
    actorId: "viv",
    namespace: "tenant-a",
    allowedActionIds: [],
  }],
]);

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
            client.actions.submit("notes.save", { text: "Intruder." }, {
              idempotencyKey: "auth-1",
            })
          ),
          401,
        );
      }
      // The key was never admitted: Ada can use it for different text.
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("notes.save", {
        text: "Mine.",
      }, { idempotencyKey: "auth-1" });
      assert.equal(
        noteOf(await ada.operations.result(receipt.operationId)).text,
        "Mine.",
      );
    }),

  // An allowed principal saves a note and reads its own result.
  "owner reads its own result": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("notes.save", {
        text: "Plan the launch.",
      }, { idempotencyKey: "own-1" });
      assert.equal(
        noteOf(await ada.operations.result(receipt.operationId)).text,
        "Plan the launch.",
      );
    }),

  // Same key and input is one operation; same key with new input is a conflict.
  "idempotency key maps to one submission": () =>
    withApp(async (app) => {
      const ada = clientFor(app, "token-ada");
      const first = await ada.actions.submit("notes.save", {
        text: "Once.",
      }, { idempotencyKey: "retry-1" });
      const retry = await ada.actions.submit("notes.save", {
        text: "Once.",
      }, { idempotencyKey: "retry-1" });
      assert.equal(retry.operationId, first.operationId);
      assert.equal(
        noteOf(await ada.operations.result(retry.operationId)).id,
        noteOf(await ada.operations.result(first.operationId)).id,
      );
      assert.equal(
        await rejectedStatus(() =>
          ada.actions.submit("notes.save", { text: "Twice." }, {
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
      const receipt = await ada.actions.submit("notes.save", {
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
      const receipt = await ada.actions.submit("notes.save", {
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
          grace.actions.submit("notes.save", { text: "Ada's draft." }, {
            idempotencyKey: "owner-1",
          })
        ),
        409,
      );
      // Ada still owns an intact result.
      assert.equal(
        noteOf(await ada.operations.result(receipt.operationId)).text,
        "Ada's draft.",
      );
    }),

  // A principal without the Action gets 403 and admits nothing.
  "action outside the allowlist is forbidden": () =>
    withApp(async (app) => {
      const viv = clientFor(app, "token-viv");
      assert.equal(
        await rejectedStatus(() =>
          viv.actions.submit("notes.save", { text: "Not allowed." }, {
            idempotencyKey: "deny-1",
          })
        ),
        403,
      );
      // Nothing was admitted in tenant A under that key.
      const ada = clientFor(app, "token-ada");
      const receipt = await ada.actions.submit("notes.save", {
        text: "Allowed.",
      }, { idempotencyKey: "deny-1" });
      assert.equal(
        noteOf(await ada.operations.result(receipt.operationId)).text,
        "Allowed.",
      );
    }),

  // A namespace in the query string or a header does not choose the tenant.
  "request cannot choose its tenant": () =>
    withApp(async (app) => {
      const response = await app.fetch(
        new Request(
          "http://notes.test/api/actions/notes/save?namespace=tenant-b",
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
        noteOf(await ada.operations.result(operationId)).text,
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

Both runners report **7 passed** and 0 failed. The tests check statuses and
results, not exact error messages or generated IDs.

Then confirm the local host still works with its new principal. Start `serve.ts`
(or `serve-node.ts`) as in Chapter 15 and run the client with a fresh key:

```sh
# Deno client against the running host.
deno run --allow-net=127.0.0.1:8000 call-notes.ts "Isolate tenants." note-016
```

It prints an `operation …` line and `saved note=… text="Isolate tenants."`,
because the local identity's `allowedActionIds` includes `notes.save` and the
client reads only operations it started. Stop the host with Ctrl+C.

## What this unlocks

- One deployment can serve many tenants and users: the namespace and the
  operation owner come from the verified principal, so a forged query string or
  header cannot move a request into another tenant.
- Per-Action permissions without new routes: add an Action to `publicActions` to
  expose it, and to a principal's `allowedActionIds` to let that principal call
  it.
- Operation privacy inside a tenant: status, results, observation and
  cancellation only reach the actor who started the operation.
- A default-deny posture: Asset, Collection, Channel and custom routes stay
  closed until you write a policy for them.
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
- Reference: [HTTP server and browser client](../../server.md) lists endpoint
  kinds, scope fields and every constraint `authorize` can return.
- Reference: [Testing and inspection](../../testing-and-inspection.md) covers
  scenario tests against `app.fetch`.
