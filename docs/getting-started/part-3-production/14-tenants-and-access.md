---
title: "Ch 14: Tenants and Access"
description: "Derive Copilotz scope from trusted identity and keep authorization separate from namespace selection."
section: Getting Started
order: 140
status: stable
---

# Chapter 14: Tenants and Access

## The pain

A request can carry a thread ID, collection ID, or tenant label. Those values
identify what the caller wants to reach; they do not prove that the caller may
reach it. A durable namespace helps partition state, but it cannot decide which
people are allowed to use an Action or read a record.

## The solution

Use the host's verified principal as the source for the Server facade scope.
Keep tenant lookup and authorization in trusted host policy, then test the
boundary with callers from different tenants.

### Map a verified principal to a Copilotz scope

Create `tenant-scope.ts` at the project root. This helper accepts an identity
that the host has already authenticated and validates the required scope values
before returning them. It does not parse tokens or decide membership.

```ts
// Import the Server scope contract without adding a runtime dependency.
import type { ServerAuthorizedScope } from "@copilotz/copilotz/server";
// Reuse the verified principal shape accepted by the Chapter 11 server factory.
import type { NotesPrincipal } from "./server.ts";

// Reject absent or whitespace-only host identity fields before request dispatch.
function required(value: string, label: string): string {
  // Trim host values so semantically empty identifiers cannot become scope.
  const normalized = value.trim();
  // Fail closed if the authenticated session lacks a required scope value.
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  // Return one canonical value for every runtime request in this session.
  return normalized;
}

// Convert host-verified tenant identity into the trusted facade scope.
export function tenantScope(
  // Accept only the principal shape returned by the host's session resolver.
  principal: NotesPrincipal,
): ServerAuthorizedScope {
  // Validate the optional physical scope only when the host supplied it.
  const databaseSchema = principal.databaseSchema
    ? required(principal.databaseSchema, "Database schema")
    : undefined;
  // Return a scope derived from identity, never from client-selected body data.
  return {
    // Attribute policy decisions and durable operations to the verified actor.
    actor: { id: required(principal.actorId, "Actor ID") },
    // Partition semantic records with the host-resolved tenant identifier.
    namespace: required(principal.namespace, "Namespace"),
    // Preserve an optional host-selected physical database scope.
    ...(databaseSchema ? { databaseSchema } : {}),
  };
}
```

In `server.ts`, add this import and replace the inline `scope` object inside
`authenticate()` with `return tenantScope(principal);`:

```ts
// Import the shared mapping from verified host identity to runtime scope.
import { tenantScope } from "./tenant-scope.ts";
```

That is a targeted edit to the existing Chapter 11 server file. The
`resolvePrincipal` callback still must authenticate the request and resolve the
person's current tenant membership. A caller-provided `namespace` must never
override that result.

## Breaking it down

`namespace` is the logical partition used by durable semantic records and
content. `databaseSchema` selects the physical database schema where the runtime
stores that partition. An application can map tenants to namespaces inside one
database, or make another trusted placement choice. Neither value alone
authenticates a caller or implements a per-record policy.

Authentication establishes trusted `actor`, `namespace`, and optional database
scope. Authorization decides what that identity may do for a matched endpoint.
For example, exposing `notes.save` says the route exists; it does not say every
signed-in person may use it. Use the Server facade's `authorize` callback for
request-specific action constraints and collection filters. A read filter does
not authorize a Collection mutation; mutation policy is separate. Keep the
policy in the host layer that knows the application's roles and record
ownership.

Before deployment, exercise at least these cases against the host's real session
resolver:

- A missing or invalid session is rejected before an Action runs.
- A valid principal is assigned its server-resolved namespace even if a request
  supplies another tenant label.
- A principal cannot read or mutate another tenant's records by guessing IDs.
- Replaying the same idempotency key recovers only the original authorized
  operation in the same scope.

The [Server reference](../../server.md) describes how its facade compiles
authentication and authorization policy. The application must also apply its
host framework's CSRF, cookie, CORS, rate-limit, and session-expiration rules
where those controls are relevant.

## What this unlocks

- Namespace and database placement follow authenticated host identity.
- Route exposure, authentication, and per-request authorization stay distinct.
- Tenant isolation can be tested at the boundary where caller-supplied IDs are
  actually handled.

## What's next

Once the policy and storage boundaries are explicit, choose how the runtime
should be hosted.
[Chapter 15: Deployment and Next Steps](15-deployment-and-next-steps.md) starts
with embedded mode and shows when a Gateway and Worker are useful.
