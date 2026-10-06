---
title: "Chapter 15: Expose an HTTP API"
description: "Let other programs call the notes.save Action over HTTP through an explicit Fetch boundary, while the host owns the listener and decides which caller is trusted."
section: Getting Started
order: 150
status: stable
---

# Chapter 15: Expose an HTTP API

> Part 4 — Release to Users · Track: R · Requires: Chapter 5 · Needs: Deno 2.9+
> or Node 24+ (no credential; Node also needs `@hono/node-server`)

## The pain

Notes only works from inside its own process. `app.ts` saves a note because it
imports the plugin and calls `app.send` itself. A browser, a script on another
machine or a teammate's service cannot do that: they have no way into your
process, so the `notes.save` Action you designed is unreachable to them.

The obvious fix, writing a small web handler that parses JSON and calls the
Action, brings its own trouble. Every handler has to decide who the caller is,
which tenant they write to, what happens when a request is retried after a lost
response, and which other Actions it must not reach. Get one of these wrong and
a retry saves a note twice, or a request body picks another tenant's namespace.

## The problem

An HTTP boundary is a **trust boundary**. Three things must hold:

- **Narrow exposure.** Only the operations you choose are callable. Adding a
  plugin later must not silently publish its Actions.
- **Trusted identity.** The actor and namespace come from something the host
  verified, never from the request body or query string.
- **Idempotent submission.** A network retry of the same logical submission must
  map to the same operation, not a second note.

The listener itself (port, address, process signals, shutdown) is a host
concern. The definition of what is exposed should stay pure and reusable, so
tests can call it without opening a socket.

## The solution

Compose the public `serverPlugin` with a **server facade**: a resource, created
by `defineServerFacade`, that declares what the facade exposes and how each
request is authenticated. The application returned by `createCopilotz` then has
an `app.fetch(request)` method, a standard Fetch handler that any host can
serve. On the facade:

- `expose.actions: { include: ["notes.save"] }` exposes only this Action.
  Without it, the facade's default exposes every registered Action, Collection
  read and Channel. `collections: false` and `channels: false` turn those
  families off.
- `authenticate(request, context)` runs for every facade request. It returns the
  trusted scope (`actor`, `namespace`, `databaseSchema`) or a `Response`, such
  as a 401, to reject the request.
- Clients send an `Idempotency-Key` header with each submission. The same key
  with the same input returns the original operation; the same key with
  different input is rejected.

`expose` selects which Actions, Collections and Channels the facade publishes.
The facade still has its fixed routes, such as operation status and results,
Assets and `GET /api/openapi.json`. `authenticate` runs for every matched facade
route, those included; a path that matches no route returns 404. Which caller
may read which operation is a request-authorization decision, and
[Chapter 16](16-authenticate-and-isolate-tenants.md) designs it.

Route exposure is not record policy. Collection routes are off here, but
`notes.save` still writes the `note` Collection through its own input schema and
validation. Exposing an Action means anyone who passes `authenticate` may run it
with valid input.

In this chapter the host's principal resolver is a simple credential check: one
fixed token mapped to one local demo identity.
[Chapter 16](16-authenticate-and-isolate-tenants.md) adds a trusted-principal
policy with per-request authorization, and shows a production host supplying the
verification it already has.

Action IDs keep their stable identity in the URL: dots become path separators,
so `notes.save` is `POST /api/actions/notes/save`. The public client builds that
path for you.

### Install the Node listener bridge

Deno serves `app.fetch` with `Deno.serve`, so the Deno host needs nothing new.
Node has no built-in Fetch listener; the Node host uses `@hono/node-server`:

```sh
# Node only: the bridge from a Node HTTP listener to a Fetch handler.
npm install @hono/node-server@2.1.3
```

If you type-check the Node host with Deno, also add
`"@hono/node-server": "npm:@hono/node-server@2.1.3"` to the `imports` in your
`deno.json`. Running `serve.ts` on Deno does not need it.

### Create `server.ts`

`server.ts` is a **definition module**. It exports a factory that composes the
Notes plugin with the server facade, and it chooses no listener, no persistent
database and no credential. Every host choice arrives as an option: the trusted
principal resolver, the namespace and the database. Tests call the factory
without `database` and get the private in-memory default. Its only local import
is `notes-plugin.ts`, so the runtime track stays free of
`@copilotz/copilotz/core`.

```ts
// Runtime factory, plus the public type of every accepted database choice.
import { createCopilotz } from "@copilotz/copilotz";
import type { CopilotzDatabaseInput } from "@copilotz/copilotz";
// The Fetch boundary: its plugin, the facade declaration and the
// authentication callback type.
import { defineServerFacade, serverPlugin } from "@copilotz/copilotz/server";
import type { ServerAuthenticate } from "@copilotz/copilotz/server";
// The reusable Notes package that owns `notes.save`.
import { notesPlugin } from "./notes-plugin.ts";

// A caller the host has already verified. The server only copies these values
// into the request scope; it never reads identity from the request body.
export type Principal = Readonly<{
  // Stable ID of the acting user, recorded on the operations they start.
  actorId: string;
  // Tenant the caller works in. Records and operations are scoped to it.
  namespace: string;
  // Optional database schema for hosts that separate tenants by schema.
  databaseSchema?: string;
}>;

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
    // Scope comes only from the verified principal, never from body or query.
    return {
      actor: { id: principal.actorId },
      namespace: principal.namespace,
      ...(principal.databaseSchema
        ? { databaseSchema: principal.databaseSchema }
        : {}),
    };
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
        }),
      },
    },
  });
}
```

This chapter has no `authorize` callback. Authorization constrains Action input,
Collection filters and operation ownership after authentication; the
[Server reference](../../server.md) describes it, and Chapter 16 uses it.

### Create `serve.ts`

`serve.ts` is the Deno **entrypoint**. It passes `composition.ts`'s namespace
and database to the factory, so the HTTP host opens the same database as
`app.ts`. It accepts one fixed development token and maps it to one local
principal. The listener accepts loopback connections only, and the fixed token
is a local demo identity. On `SIGINT` or `SIGTERM` it shuts the listener down
gracefully, letting pending requests finish, and then closes the application.

Run it with `deno run -A` in this guide. The host needs the listener, the
database location chosen in `composition.ts`, and the database engine's own
assets, which Deno reads from its module cache.

```ts
// The same host choices as `app.ts`.
import { database, namespace } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The one local demo identity this development host trusts.
const localUser: Principal = { actorId: "local-guide-user", namespace };

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
});

// Set once the listener starts, so a signal can shut it down gracefully.
let server: Deno.HttpServer | undefined;
const stop = () => void server?.shutdown();

try {
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);

  server = Deno.serve({
    // Accept loopback connections only.
    hostname: "127.0.0.1",
    port: 8000,
    onListen: ({ hostname, port }) =>
      console.log(`Notes API on http://${hostname}:${port}/api`),
  }, app.fetch);

  // Resolves after `shutdown()` has let pending requests finish.
  await server.finished;
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database, even after a
  // startup failure.
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
  await app.close();
}
```

### Create `serve-node.ts`

`serve-node.ts` is the Node **entrypoint**: the same application, served through
`@hono/node-server`. Use it instead of `serve.ts` on Node.

```ts
// Bridges a Node HTTP listener to a Fetch handler.
import { serve } from "@hono/node-server";
// Shutdown signals.
import process from "node:process";
// The same host choices as `app.ts`.
import { database, namespace } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The one local demo identity this development host trusts.
const localUser: Principal = { actorId: "local-guide-user", namespace };

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
});

// Set by the listener lifecycle below; the `finally` block removes them.
let stop = () => {};
let fail = (_error: Error) => {};
let server: ReturnType<typeof serve> | undefined;

try {
  // Accepts loopback connections and forwards every request to `app.fetch`.
  const listener = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 8000 },
    (info) => console.log(`Notes API on http://127.0.0.1:${info.port}/api`),
  );
  server = listener;

  // Resolves once a signal has closed the listener; rejects on a listener
  // failure, such as the port being in use.
  await new Promise<void>((resolve, reject) => {
    stop = () => listener.close((error) => (error ? reject(error) : resolve()));
    fail = reject;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    listener.on("error", fail);
  });
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database, after a clean
  // shutdown or a failure.
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  server?.off("error", fail);
  await app.close();
}
```

### Create `call-notes.ts`

`call-notes.ts` is an **entrypoint** for the caller's side. It imports only the
public `@copilotz/copilotz/client`, not the server or any plugin, just as a
separate program would. It takes the note text and an idempotency key from the
command line.

The key names one logical submission. The caller creates it once, stores it with
the submission, and reuses it on every retry. A new key is a new operation;
reusing a key with different text is rejected. Generating a fresh random key on
every run would make each run a new note, so this script requires the key
instead. The client already retries lost responses with the same key and input.

The script submits with `client.actions.submit`, which returns the operation's
receipt, and then reads the result with `client.operations.result`. Printing the
receipt's `operationId` gives you the ID that Chapter 7's `recover.ts` replays.
When a caller needs only the output, `client.actions.invoke` combines both
steps.

```ts
// Fetch-only client for the facade, and its HTTP error type.
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "@copilotz/copilotz/client";
// Command-line input and exit status.
import process, { argv } from "node:process";

// Both values are required: the note, and the caller's stable submission key.
const [text, idempotencyKey] = argv.slice(2);
if (!text || !idempotencyKey) {
  throw new Error('Usage: call-notes.ts "<note text>" <idempotency-key>');
}

const client = createCopilotzClient({
  // The local development host from serve.ts or serve-node.ts.
  baseUrl: "http://127.0.0.1:8000/api",
  // The fixed loopback development credential. A production caller would get
  // its URL and credential from its own host configuration.
  getRequestHeaders: () => ({ authorization: "Bearer local-dev-token" }),
});

// Reads one field of an object, or nothing when the value is not an object.
function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

try {
  // Submits `notes.save`. The receipt names the operation; a retry with the
  // same key and input returns the same operation.
  const receipt = await client.actions.submit("notes.save", { text }, {
    idempotencyKey,
  });
  console.log(`operation ${receipt.operationId}`);
  // Waits for the operation's result. It is `unknown` because it crosses a
  // network boundary.
  const output = await client.operations.result(receipt.operationId);
  const id = field(output, "id");
  const saved = field(output, "text");
  // Print only the note's identity and text, or the raw result if it differs.
  console.log(
    typeof id === "string" && typeof saved === "string"
      ? `saved note=${id} text=${JSON.stringify(saved)}`
      : `result ${JSON.stringify(output)}`,
  );
} catch (error) {
  // HTTP failures carry a status and a stable code.
  if (error instanceof CopilotzHttpError) {
    console.error(`rejected status=${error.status} code=${error.code}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

## Check it works

Start one host in the first terminal, then run the client in a second terminal.
When `composition.ts` uses a local directory such as `file://./data`, do not run
`app.ts` or `recover.ts` against it while the server is running.

**Deno** (first terminal):

```sh
# Serve the Notes API on loopback with the composition database.
deno run -A serve.ts
```

**Node 24+** (first terminal, alternative to Deno):

```sh
# Serve the same application through the Node listener bridge.
node serve-node.ts
```

The host prints `Notes API on http://127.0.0.1:8000/api`. In the second
terminal, use one runtime:

```sh
# Deno: submit a note with a caller-chosen key.
deno run --allow-net=127.0.0.1:8000 call-notes.ts "Ship the API." note-001
# Same text, same key: a retry of the same submission.
deno run --allow-net=127.0.0.1:8000 call-notes.ts "Ship the API." note-001
# Same key, different text: a different request reusing the key.
deno run --allow-net=127.0.0.1:8000 call-notes.ts "Something else." note-001
```

```sh
# Node: the same three calls.
node call-notes.ts "Ship the API." note-001
node call-notes.ts "Ship the API." note-001
node call-notes.ts "Something else." note-001
```

Expected facts (IDs differ on every machine):

```text
operation 3f6c…
saved note=5b91… text="Ship the API."
operation 3f6c…
saved note=5b91… text="Ship the API."
rejected status=409 code=idempotency_conflict
```

- The first two calls print the **same** operation ID and the **same** note ID:
  the retry returned the original operation instead of saving twice.
- The third call is rejected with `409 idempotency_conflict` and exits non-zero,
  because the key already belongs to different input.
- A new key, such as `note-002`, saves a second note with a new ID.

To check authentication, temporarily change the client's token (or remove
`getRequestHeaders`) and run it with a new key. It prints
`rejected status=401 code=unauthorized` and saves nothing.

Press Ctrl+C in the first terminal. The host prints `listener stopped` and exits
after closing the application.

The hosts open whatever database `composition.ts` chooses. With Chapter 5's
`:memory:` choice, the notes, their history and the idempotency keys end when
the host closes. After Chapter 7's `file://./data` (or a shared database), they
survive restarts, and once the server has stopped, `recover.ts` can replay an
operation by the ID that `call-notes.ts` printed.

## What this unlocks

- Any program that speaks HTTP can save notes, with the same `notes.save`
  validation as in-process callers.
- Retries are safe when callers keep a stable idempotency key per submission,
  for as long as the chosen database keeps the operation.
- The server definition is pure: tests call `createServerApp` and `app.fetch`
  directly, with no listener and a private in-memory database.
- The host alone decides the listener, database and trusted principal, so moving
  from the development token to real verification changes the host, not the
  Notes package.

## Next steps

- Next:
  [Chapter 16: Authenticate and Isolate Tenants](16-authenticate-and-isolate-tenants.md)
  replaces the development token with verified principals and adds per-request
  authorization and operation ownership.
- Reference: [HTTP server and browser client](../../server.md) lists the
  facade's routes, exposure options and the `authorize` callback.
- Reference: [API](../../api.md) covers `createCopilotz` and `app.fetch`.
