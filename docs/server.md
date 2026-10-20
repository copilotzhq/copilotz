---
title: "HTTP Server and Client"
description: "Serve chosen Actions, Collections and Channels through one Fetch handler with trusted identity, owner-evaluated authorization, idempotent submission and a portable client."
section: Deliver
order: 10
status: stable
---

# HTTP Server and Client

## The pain

Your Notes application works in-process, but a browser, a mobile app or another
service needs to save notes too. Writing your own handlers means re-deciding, in
every route, who the caller is, which tenant they touch, what a retried POST
does, which operations they may read back and how a long-running result is
streamed. Each hand-written route is another place where a request body can pick
someone else's namespace or a lost response saves a note twice.

## The problem

You need one HTTP contract that:

- publishes only the Actions, Collections and Channels you choose;
- takes actor and tenant from host verification, never from the request;
- authorizes everything a matched route does, including the fixed operation and
  Asset routes, where the data is written;
- maps a retried submission to the original operation;
- runs on any Fetch host (Deno, Node, Workers) and has a matching client.

## The solution

Compose `serverPlugin` with a facade declared by `defineServerFacade` under
`resources.server.default`, and give `createCopilotz` an `authorization`
registration. The application then exposes `app.fetch(request)`, a standard
Fetch handler. The host owns the listener; `createCopilotzClient` from
`@copilotz/copilotz/client` calls it.

### Install

Copilotz is published on JSR. Set up the project as in the
[Quickstart](quickstart.md):

```sh
# Deno: add Copilotz with import mappings for its plugin subpaths.
deno add jsr:@copilotz/copilotz@^0.89.0
```

Deno 2.9 holds back versions published in the last 24 hours by default; for a
fresh release add the Copilotz-only `minimumDependencyAge` exception from the
[Deno setup](getting-started.md#deno).

```sh
# Node: create package.json and treat .ts files as ES modules.
npm init -y
npm pkg set type=module
# Install Copilotz from JSR, and PGlite, the database the runtime opens.
npx jsr add @copilotz/copilotz@^0.89.0
npm i @electric-sql/pglite
```

Only a Node host that opens a real listener also needs
`npm i @hono/node-server@2.1.3`. The worked example below needs no listener.

### Exposure, authentication, authorization

Three decisions stay separate:

| Option                           | Decides                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| facade `expose`                  | which Action, Collection and Channel **families** get routes                     |
| facade `authenticate`            | the trusted scope and authority binding for a request, or a `Response` to reject |
| `createCopilotz` `authorization` | what that authority may do, evaluated by the owner inside every command          |

`expose.actions`, `expose.collections` and `expose.channels` each accept `true`,
`false` or `{ include, exclude }` patterns over stable IDs. Omitting `expose`
publishes every registered Action, Collection read and Channel, so list what you
mean. For Collections, `true` or patterns expose **reads only**; write routes
(create, update, delete, commands) need an explicit `operations` entry, such as
`collections: { include: ["note"], operations: { include: ["create"] } }` (or
`operations: true`), and then a matching `collectionMutations` grant from the
owner policy. `expose` never removes the facade's fixed routes: operation
status/result/cancel/observe, Assets and `GET <basePath>/openapi.json` always
exist. `authenticate` runs for those as well, and the policy decides what they
return. `basePath` defaults to `/api`; `maxAssetUploadBytes` defaults to 20 MiB.

`authenticate(request, context)` is required: without it, `createCopilotz`
refuses to build the facade. `context` carries the matched `endpoint` (`kind`,
stable `id`, `key` and route `metadata`), its `params`, and the application's
`defaultNamespace` and `defaultDatabaseSchema`. It returns a
`ServerAuthorizedScope`:

- `authority`: the `AuthenticatedAuthority` binding the owner evaluates. Its
  `scope.namespace` and `scope.databaseSchema` must equal the returned scope's;
  the facade fills in the matched endpoint, operation and parameters as request
  facts.
- `actor`: the authenticated actor, recorded as `actorId` on every operation the
  request starts and passed to Actions as trusted `httpActor` metadata.
- `namespace` and optional `databaseSchema`: the tenant and physical schema.
- optional trusted `operationMetadata`, `actionMetadata`, `identity` and a
  host-only `context`.

A namespace is a tenant, not a permission: two users of one tenant can still
read each other's operations unless the policy constrains them.

For every command a route starts, the owner runs the policy that the binding
names and applies the `ServerConstraints` it returns: an `actions` allowlist,
`collections` read filters, `collectionMutations` write grants, `operations`
metadata for ownership, `assets` reads and `sessions` permissions. Every exposed
Action and Collection needs a binding in `authorization`, keyed by alias;
`createCopilotz` refuses to start without one. Operations whose metadata does
not match the policy's `operations` constraint are treated as not found (404)
for get, result, cancel and observe, so a policy that returns
`operations: { metadata: { initiatorUserId: authority.principal.id } }` both
stamps each new operation with its initiator and limits reads to that initiator.
Grant nothing for endpoint kinds you have no policy for. See
[Owner authorization](authorization.md) for the complete contract.

### Routes and identity

Action IDs keep their stable identity in the path: dots become segments, so
`notes.save` is `POST /api/actions/notes/save`. Submissions answer `202` with a
receipt (`operationId`, `correlationId`, `status`, `acceptedAt`, and optional
`checkpoint`/`thread`).

Application-specific endpoints come from `createHttpAdapter({ routes })` in
`@copilotz/copilotz/server`, registered as
`adapters: { http: { <alias>: ... } }`. Each route has an `id`, `method` and a
`path` relative to `basePath`, and exactly one of:

- `action` — a stable Action ID (not a caller alias), optionally with an
  `input(context)` mapper. It is independent of `expose.actions` and answers
  `202` with a receipt like any submission.
- `handler(context)` — your code; its return value is normally answered with
  `200`. `context.invoke(actionId, input, options)` runs an Action and waits for
  its result; there is no submit variant. `context.read` reads Collections under
  the request's authority; a Collection without a binding is forbidden.
  `context.sessions` creates and revokes owner sessions, as
  [Owner authorization](authorization.md#sessions-and-logout) shows. Ambient
  `app.actions` and `app.collections` calls inside handlers also carry the
  caller's authority. Calls from host code, such as startup or scripts, remain
  trusted.

Server startup checks exposed Collection bindings. HTTP adapters can declare
Collection aliases in `collections` for the same check; core-http requires
`thread`, `participant` and `message`. A missing binding names the alias in the
startup error.

Route `metadata` labels are trusted inputs that `authenticate` can read via
`context.endpoint.metadata`, for example to reject a route by returning a
`Response`. They grant nothing by themselves, including public-route exemptions.

Action and Collection mutation submissions carry an `Idempotency-Key`. External
Channel webhooks instead use stable provider occurrence IDs; only
request-observation Channels require that header. See [Channels](channels.md).
For an Action submission, the same key with the same input from the same trusted
identity returns the original receipt; different input fails with
`409 idempotency_conflict`, and so does the same key from a different actor,
without disclosing the original. Use one stable key per logical submission.

Admission validates input against the target's input schema before anything
runs. Fields marked with `secret()` from `@copilotz/copilotz/actions`, with a
secrets adapter registered, are kept out of recorded history and observation
(only an authorized result read returns plaintext output). Any other input is
ordinary recorded business data, so never send credentials in unmarked fields.
Large or binary content belongs in Assets; see
[Content and Assets](content-assets.md).

### Results and observation

`client.operations.result(id)` returns the target Action's output once that
Action and its own streams are complete. It does not wait for descendant work:
for a Core `sendConversation`, it returns `{ threadId, message }` possibly
before any model output, and the enclosing operation may still fail later. When
you need full completion, observe the operation until a terminal status and
handle semantic failures such as `llm.call.failed` yourself.
`client.actions.invoke` is submit plus `result`, with the same boundary.

Action submissions still return `202` receipts. A failed Action's result read
returns `422` with an `error` body containing code `action_failed` and message
`Action execution failed.`, unless the Action threw a
[caller-safe `ActionError`](actions.md#caller-safe-errors). That error's message
and code pass through with its chosen 4xx status (default `422`), including on
replay. A custom route's `context.invoke` rejects with the same message, code
and status; the handler can catch it or let the HTTP facade return that error
body. Adding a code or HTTP status to an ordinary Error does not grant message
disclosure. Secret-marked Action schemas retain generic errors even for
`ActionError`.

Collection mutation schema and missing-relation failures return `422` with code
`collection_validation_failed` and a plain validation message. Input schema
errors can reject submission; final-record and relation errors reject the
recorded result read. Unexpected mutation execution failures remain
`collection_mutation_failed` / `Collection mutation did not complete.`. Error
reporting does not bypass authentication, authorization or result-read scope.

`client.operations.observe({ operationIds, onFrame })` streams multipart frames
for 1–32 concurrently selected operations and resolves with a checkpoint for
resuming. Each observation response has a bounded lifetime (at most five minutes
by default) and may also renew under load; the client follows these renewal
frames transparently. Long-lived credentials are re-authorized the same way: an
admission lasts at most 15 minutes, and the client authenticates again when it
renews. Exhausted replay capacity is different: the client rejects with
`operation_replay_capacity_exceeded`, and you must bootstrap from a fresh
history read. See [Observation performance](observation-performance.md). A
well-formed closing boundary without a terminal descriptor is not proof that the
operation finished. Old cursor generations are rejected after the explicit
offline catalog upgrade in [Upgrading](upgrading.md).

Raw operation observation and raw thread observation have no history privacy
filter. An authorized observer receives every stream, including private Ask
answers. Treat both as trusted diagnostic surfaces; end-user views should read
Core's normal, visibility-filtered history (`core.threads.messages`), and the
policy should not grant raw observation where private data must not reach that
user. Hiding bytes in browser JavaScript is not a confidentiality boundary.

### Core routes

Thread, message and agent routes belong to `coreHttpPlugin` from
`@copilotz/copilotz/core/server`, a separate optional plugin. Its routes read
through `context.read`, so add it to `plugins`, bind the `thread`, `message` and
`participant` Collections and return appropriate membership filters from policy,
as
[Chapter 17](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md)
shows. Startup refuses a missing binding and names the Collection alias.
Runtime-only applications never need the plugin.

### Worked example: call the facade without a listener

This check reuses the accepted `notes-plugin.ts`, `auth.ts` and `server.ts` from
[Chapter 16](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md)
unchanged. It injects `app.fetch` into the client, so it opens no port, needs no
credential and uses the private in-memory database. Create `server-check.ts`:

```ts
// Public HTTP client and its error type.
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "@copilotz/copilotz/client";
// The pure server factory and principal type from Chapter 16.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";
// The host helper that writes memberships.
import { grantRoles } from "./auth.ts";

// Two verified users in the same tenant.
const users: Record<string, Principal> = {
  "token-ada": { actorId: "ada", namespace: "team-notes" },
  "token-bob": { actorId: "bob", namespace: "team-notes" },
};

// No database option: a private in-memory database for this check.
const app = await createServerApp({
  // Stand-in for host verification: an exact bearer-token lookup.
  resolvePrincipal: (request) =>
    users[request.headers.get("authorization")?.replace("Bearer ", "") ?? ""],
});

// Builds a client that calls `app.fetch` directly. The URL only needs to be
// absolute; no request leaves the process.
const clientFor = (token: string) =>
  createCopilotzClient({
    baseUrl: "http://notes.invalid/api",
    getRequestHeaders: () => ({ authorization: `Bearer ${token}` }),
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });

// Runs one call and reports its HTTP status instead of throwing.
async function status(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "ok";
  } catch (error) {
    if (error instanceof CopilotzHttpError) {
      return `${error.status} ${error.code}`;
    }
    throw error;
  }
}

try {
  // Both are members of the tenant; only Ada may save notes.
  await grantRoles(app, "ada", ["editor"], { namespace: "team-notes" });
  await grantRoles(app, "bob", [], { namespace: "team-notes" });

  const ada = clientFor("token-ada");
  const bob = clientFor("token-bob");
  const key = { idempotencyKey: "server-check-001" };

  // Submit, then retry the same logical submission with the same key.
  const first = await ada.actions.submit("notes.save", { text: "Hi" }, key);
  const retry = await ada.actions.submit("notes.save", { text: "Hi" }, key);
  console.log("same operation:", first.operationId === retry.operationId);
  console.log("result:", await ada.operations.result(first.operationId));

  // Same key, different input.
  console.log(
    "conflict:",
    await status(() => ada.actions.submit("notes.save", { text: "No" }, key)),
  );
  // Same tenant, different actor: the policy grants Bob no Action...
  console.log(
    "bob save:",
    await status(() => bob.actions.submit("notes.save", { text: "Hi" }, key)),
  );
  // ...and only operations he started.
  console.log(
    "bob read:",
    await status(() => bob.operations.get(first.operationId)),
  );
  // No credential at all.
  console.log(
    "anonymous:",
    await status(() => clientFor("nobody").operations.get(first.operationId)),
  );
} finally {
  // Release the in-memory database even if a check throws.
  await app.close();
}
```

Run it with `deno run -A server-check.ts` (the in-memory database reads its
engine assets from Deno's module cache) or `node server-check.ts`. Expected
facts (IDs differ):

```text
same operation: true
result: { id: "…", text: "Hi", … }
conflict: 409 idempotency_conflict
bob save: 403 forbidden
bob read: 404 …
anonymous: 401 unauthorized
```

To serve the same app for real, use `serve.ts` (`Deno.serve` with
`server.shutdown()` on signals) or `serve-node.ts` (`@hono/node-server` with
`listener.close()`) from
[Chapter 15](getting-started/part-4-release-to-users/15-expose-an-http-api.md),
and close the app after the listener finishes.

## What this unlocks

- One Fetch handler for Deno, Node and Workers, with tests that need no socket.
- Exposure, identity and ownership as separate, reviewable decisions.
- Safe client retries through idempotency keys and receipts.
- Browser and service callers sharing one public client.

## Next steps

- [Chapter 15: Expose an HTTP API](getting-started/part-4-release-to-users/15-expose-an-http-api.md)
- [Chapter 16: Authenticate and Isolate Tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md)
- [Channels](channels.md) for inbound adapters and chat delivery.
- [Content and Assets](content-assets.md) for uploads and large inputs.
