# Server Plugin

## What it is

The semantic Copilotz HTTP facade over composed Actions, Collections, Channels,
Assets, and safe Agent projections.

## Why it exists

Applications should not rebuild primitive discovery, validation, durable Action
dispatch, streaming, and OpenAPI generation for every HTTP server.

## How to use it

Compose
`createServerPlugin({ basePath: "/api", authenticate, authorize, expose })`.
Oxian or another Fetch host serves the resulting `app.fetch` directly. This is
the only HTTP boundary; there are no versioned routes or compatibility
transports.

`createCoreServerPlugin()` contributes conversation endpoints and ordinary Core
mutation Actions. Applications contribute exact `createHttpAdapter({ routes })`
descriptors for business endpoints. Every descriptor participates in the same
authentication, authorization, validation, errors, and OpenAPI route compiler.

Authentication receives the matched endpoint and resolves trusted scope. Policy
constraints intersect collection filters before pagination, and Action inputs
before execution. Handlers receive scoped reads, content, operations, and Action
invocation capabilities. A host may return an `admission` conversation key to
reject additional submissions once 32 operations are active; existing receipts
remain recoverable. This admission check reuses the operation catalog.
Observation also enforces its own operation and stream bounds, including
concurrent admissions.

Browser applications use `@copilotz/copilotz/client` and
`@copilotz/copilotz/core/client`. Submissions require stable idempotency keys
and return 202 operation receipts. Multipart observation sends canonical
descriptors, raw bytes, terminal outcomes, and checkpoints. A checkpoint is
committed only after the browser's awaited `onFrame` callback succeeds.
Disconnecting an observer detaches it; `DELETE /api/operations/:id` explicitly
cancels durable work.

## How it works

The plugin contributes an immutable facade Resource and a durable Event-to-
Action bridge. The package Server boundary compiles routes from the complete
composition and handles Fetch/OpenAPI/multipart transport semantics.
