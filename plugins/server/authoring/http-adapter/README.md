# http-adapter

## What it is

Exact HTTP route descriptors in the existing Adapter category.

## Why it exists

Applications need endpoint handlers and Action bindings under the same compiled
authorization boundary.

## How to use it

Compose adapters: { http: { application: createHttpAdapter({ routes }) } } in an
ordinary plugin.

## How it works

Descriptors are validated and frozen at composition. Authentication sees the
matched descriptor and its trusted metadata; handlers receive scoped reads,
content, operations and Action invocation.

## Request body limits

An HTTP route may declare `body: { maxBytes: 20 * 1024 * 1024, raw: true }`.
`maxBytes` must be a positive safe integer. The limit applies before
authentication reads a cloned body and during parsing, including requests
without Content-Length. Omitting `body` retains the 1 MiB default. `raw: true`
gives the handler a `Uint8Array` in `context.input` regardless of Content-Type;
otherwise normal JSON/text parsing applies. Request bodies are buffered within
the declared limit, not passed through as unbuffered streams. Built-in Asset
upload limits and error codes remain separate. Use a narrow route-specific
limit, not a global bypass.
