---
title: "Ch 11: HTTP and Client"
description: "Expose the Notes Action through a policy-aware Fetch boundary and call it with the Fetch client."
section: Getting Started
order: 110
status: stable
---

# Chapter 11: HTTP and Client

## The pain

The `saveNote` Action already contains the application rule. Calling it only
through an Agent would make a web form, a job, or another service reimplement
that rule. Exposing every internal operation by default would be too broad.

## The solution

Compose the Server plugin and explicitly expose the one Action. The Server
plugin adds a Fetch handler; it does not open a port or choose your identity
provider. The host supplies verified identity and decides who may invoke the
operation.

### Add a small Notes server boundary

Create `server.ts` at the project root. Its factory accepts the host's existing
session resolver. That callback must verify a session or token and return a
trusted principal; it must not copy a namespace or database schema from an
untrusted request body.

```ts
// Import the generic application factory and the verified Server facade API.
import { createCopilotz } from "@copilotz/copilotz";
import {
  defineServerFacade,
  type ServerAuthorizedScope,
  serverPlugin,
} from "@copilotz/copilotz/server";
// Import the Action and Collection plugin created in Chapter 3.
import { notesPlugin } from "./notes-plugin.ts";

// Describe only identity fields that the host has already verified.
export type NotesPrincipal = Readonly<{
  // Use the authenticated person's stable internal actor identifier.
  actorId: string;
  // Derive the semantic namespace from trusted membership or tenant data.
  namespace: string;
  // Select a physical database scope only when the host manages that mapping.
  databaseSchema?: string;
}>;

// Let the surrounding web framework own session parsing and signature checks.
export type ResolveNotesPrincipal = (
  // Receive the original request so the host can inspect its cookie or headers.
  request: Request,
) => Promise<NotesPrincipal | null>;

// Build the server only after injecting the host's real identity resolver.
export async function createNotesServer(
  // Require authentication policy instead of shipping a demo identity.
  resolvePrincipal: ResolveNotesPrincipal,
) {
  // Compose the application-owned Action with the HTTP facade plugin.
  return await createCopilotz({
    // Supply a harmless fallback for direct application calls in this process.
    namespace: "getting-started",
    // No Core or model provider is required to expose the Notes Action.
    plugins: [notesPlugin, serverPlugin],
    // Configure the one route and the trust boundary used by that route.
    resources: {
      // The Server plugin reads its process-local facade from this Resource.
      server: {
        // Use the standard facade alias installed by serverPlugin.
        default: defineServerFacade({
          // Publish only the stable Notes Action ID through HTTP.
          expose: {
            // Publish only the stable Notes Action through HTTP.
            actions: { include: ["notes.save"] },
            // Keep Collection reads private until a read policy is designed.
            collections: false,
            // Keep Channel ingress private in this Action-only example.
            channels: false,
          },
          // Convert only a host-verified identity into a trusted runtime scope.
          async authenticate(request) {
            // Ask the host's established auth component to verify this request.
            const principal = await resolvePrincipal(request);
            // Reject absent or invalid identity before the Action is admitted.
            if (!principal) {
              return new Response("Authentication required.", {
                status: 401,
              });
            }
            // Bind every Action and read to the verified person and tenant.
            const scope: ServerAuthorizedScope = {
              // Actor identity is useful for policy and lifecycle attribution.
              actor: { id: principal.actorId },
              // Keep tenant selection on the trusted server side.
              namespace: principal.namespace,
              // Preserve a host-managed physical database assignment if present.
              ...(principal.databaseSchema
                ? { databaseSchema: principal.databaseSchema }
                : {}),
            };
            // Return the scope that the facade will use for this request.
            return scope;
          },
        }),
      },
    },
  });
}
```

The returned application has `fetch(request)`. Pass it to the Fetch listener or
framework already used by your server. The example exposes only `notes.save`; it
does not expose Collection writes. Its factory authenticates requests, but your
host must still decide which authenticated principals may save notes and whether
the Action needs additional authorization. Use `authorize` for request-specific
constraints; see the [Server reference](../../server.md).

### Run the boundary locally on Deno

For a disposable smoke test, create `serve-notes.ts` beside `server.ts`. This
host binds to loopback and uses a fixed development identity. It is deliberately
not an authentication design; replace it with the host's verified session
resolver before exposing the listener to other machines.

```ts
// Import the authenticated Notes server factory from the previous file.
import { createNotesServer } from "./server.ts";

// Build a loopback-only example that rejects the wrong development header.
const app = await createNotesServer(async (request) => {
  // Accept only the fixed local header for this disposable smoke test.
  if (request.headers.get("authorization") !== "Bearer local-only") {
    return null;
  }
  // Bind the demo caller to a fixed local actor and namespace.
  return { actorId: "local-guide-user", namespace: "getting-started" };
});

// Bind only to loopback so this development identity is not remotely reachable.
const server = Deno.serve(
  // Choose the address and port used by the local client example below.
  { hostname: "127.0.0.1", port: 8000 },
  // Hand every Fetch request to the composed Copilotz Server facade.
  (request) => app.fetch(request),
);

// Release the runtime after Deno's listener is shut down.
await server.finished;
await app.close();
```

Run this file in a Deno project with local permissions. The loopback binding and
hard-coded identity make it a local-only demonstration, not suitable for a
deployed service.

```sh
# Grant the local demo the runtime permissions its database and listener need.
deno run -A serve-notes.ts
```

### Call the Action from the Fetch client

Create `call-notes.ts` where the client can reach the mounted `/api` facade. The
The host may use a cookie, a bearer token, or another established session
mechanism. The fallback URL and header below match only the loopback demo; set
the environment values to the deployed host URL and credential format when using
a real Server facade.

```ts
// Read deployment-specific URL and token without writing either into source.
import { env } from "node:process";
// Import the Fetch-only client, which is safe to use outside the server runtime.
import { createCopilotzClient } from "@copilotz/copilotz/client";

// Create one client bound to the host's mounted Copilotz facade.
const client = createCopilotzClient({
  // Include the facade base path because Action routes live beneath /api.
  baseUrl: env.COPILOTZ_API_URL ?? "http://127.0.0.1:8000/api",
  // Forward the demo token; replace it with the host-issued session credential.
  getRequestHeaders: () => ({
    // Match the fixed development header checked by serve-notes.ts.
    authorization: env.COPILOTZ_ACCESS_TOKEN ?? "Bearer local-only",
  }),
});

// Invoke the existing Action and wait for its durable result.
const saved = await client.actions.invoke(
  // Use the Action's stable ID; dots map to path separators in the facade.
  "notes.save",
  // Supply input validated by the Action's JSON Schema.
  { text: "Review the billing screen with the product team." },
  {
    // Keep this key stable if the host retries this same logical submission.
    idempotencyKey: crypto.randomUUID(),
  },
);

// Inspect the generic result; this Action declares no output schema.
console.log(saved);
```

For durable retry after a lost client response, persist the idempotency key with
the caller's request and reuse it; generating a new key represents a new
operation. `actions.submit()` returns a receipt when the caller prefers to
observe or fetch the result separately. The browser client does not bypass
Action validation, tenant scope, or server authorization.

## Breaking it down

The Server facade compiles declared Actions and policies into one `/api`
boundary and an OpenAPI description. `serverPlugin` installs the routes on the
application's Fetch handler. The embedding host owns the network listener and
the code that validates identity. The Fetch client owns request construction,
idempotency headers, polling, and response decoding.

An Action remains an application operation whether it is called by an Agent, the
Fetch client, or another trusted caller. HTTP is one ingress for that Action,
not a second business-logic layer.

## What this unlocks

- A form or service can reuse `notes.save` without an Agent turn.
- Route exposure is explicit and the host supplies tenant scope.
- The same Fetch client can submit Actions, inspect operation receipts, and read
  allowed application data.

## What's next

The Fetch client can serve an application interface. If your product also needs
a durable Channel ingress or an interactive terminal while developing, see
[Chapter 12: Interfaces and Channels](12-interfaces-and-channels.md).
