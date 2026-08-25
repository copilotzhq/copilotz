# Server Façade

The Server plugin exposes selected composed Actions, Collections, and Channels
through one portable Fetch boundary. Oxian, Deno, Cloudflare, or another host
carries that handler; the plugin never starts a listener.

```ts
import { createServerPlugin } from "@copilotz/copilotz/server";

const server = createServerPlugin({
  basePath: "/api/v1",
  expose: {
    actions: {
      include: ["myapp.*"],
      exclude: ["myapp.internal.*"],
    },
    collections: {
      include: ["thread", "message"],
      operations: { exclude: ["command:internalCleanup"] },
    },
    channels: { include: ["web", "whatsapp"] },
  },
  overrides: {
    actions: {
      "myapp.preview.list": { path: "/features/previews/list" },
    },
  },
  async guard(request, { endpoint }) {
    const identity = await authenticate(request);
    if (!identity) return new Response("Unauthorized", { status: 401 });
    return {
      namespace: identity.tenantId,
      databaseSchema: identity.databaseSchema,
      actionMetadata: { actorId: identity.userId, endpoint: endpoint.id },
    };
  },
});
```

Compose the same plugin in Gateway and Worker roles. The Gateway automatically
mounts its configured façade and retains the internal `/v3` surface for trusted
host compatibility. A guard is optional: with no guard, every eligible primitive
is exposed in the application's default namespace and schema, which is useful
for tests and single-tenant local applications.

When the Gateway is configured with `http.resolveContext`, that process-local
host context is resolved before the guard and appears as
`guardContext.requestContext`. This is the safe bridge for an Oxian host that
already authenticated a request and selected its tenant schema: the guard may
validate those trusted facts and deliberately return the corresponding
namespace, schema, identity, and Action metadata. Request headers and bodies do
not acquire this authority automatically.

## Canonical paths

- Action `myapp.preview.list` becomes `POST /api/v1/actions/myapp/preview/list`.
- Collections receive CRUD routes plus `QUERY /collections/:name/queries/:query`
  and `POST /collections/:name/:id/commands/:command`.
- A composed Channel alias receives `/channels/:alias`.
- Assets, a sanitized Agent list, and `/openapi.json` are deliberate built-in
  projections. Arbitrary Resources are never enumerated.

Include and exclude lists use a small case-sensitive glob language where `*`
matches zero or more characters. Include defaults to `*`, exclude defaults to
empty, and exclusion wins. Overrides change only presentation paths; canonical
primitive identity remains unchanged. Composition fails for unknown exact
targets or route collisions.

Named Collection queries may declare optional `inputSchema` and `outputSchema`.
The Collection kernel validates them for both direct and HTTP calls. The route
compiler uses those same schemas when generating OpenAPI 3.2, including its
fixed `query` operation.

`Idempotency-Key` identifies a durable Action request. An exact replay returns
the already-persisted Action result without running the target again; reusing
the key with different input is rejected by the Event store.

## Secret-bearing Actions

The façade compiles the target Action's input schema before writing its bridge
Event. Fields marked `x-copilotz-secret: true` are encrypted before that first
durable write; the internal wrapper persists only request and target identities.
For JSON, the authorized request path resolves the target's terminal lifecycle
and returns its hydrated output exactly once. SSE, multipart, `observe()`, and
ordinary Event resolution retain the schema-shaped redacted value. Responses
whose output schema contains a secret marker include `Cache-Control: no-store`.

Generated OpenAPI keeps the boolean secret extension so clients can recognize
confidential inputs, but removes `default`, `const`, `enum`, `example`, and
`examples` from every marked schema node. The composed Action schema itself is
not mutated.

## Output negotiation

- `Accept: application/json`, or no explicit stream media type, waits for a
  terminal JSON response.
- `Accept: text/event-stream` retains the host's SSE compatibility path.
- `Accept: multipart/mixed` returns the exact request-scoped `ApplicationOutput`
  sequence for the whole causal turn.

Multipart descriptors preserve Copilotz output values. Progressive payloads are
raw binary frames identified by stream ID and offset; they are never base64
encoded. `decodeCopilotzOutputs(response)` reconstructs each
`StreamOutput.payload` as a local `ReadableStream<Uint8Array>`. Parallel Agent
and Tool work, nested continuations, and multiple media streams therefore stay
inside the request that created them rather than requiring per-turn stream URLs.

Input streaming and bidirectional realtime sessions are deliberately separate
future contracts.
