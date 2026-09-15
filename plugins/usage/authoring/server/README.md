# Usage HTTP adapter

## What it is

`createUsageHttpAdapter()` contributes authorized read-only Usage endpoints to
the composed Server facade. Its default routes are `/usage` for analytics and
`/usage/attempts` for bounded ledger drill-down; the facade's base path still
applies.

## Why it exists

Usage analytics must share the application's authenticated namespace and read
constraints without duplicating server policy.

## How to use it

Compose the adapter under the HTTP Adapter namespace beside `serverPlugin`.

## How it works

The adapter delegates reads to Server services, so namespace and collection
constraints are applied to aggregate and list reads before grouping or
pagination. Query parameters cannot select a namespace or database schema.
