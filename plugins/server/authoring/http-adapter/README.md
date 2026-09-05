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
