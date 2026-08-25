# Usage Collection

## What it is

The Usage Collection is the durable, source-agnostic ledger for metered work.

## Why it exists

Applications need one queryable accounting record without copying prompts,
responses, Tool arguments, or other canonical domain content.

## How to use it

Compose `createUsageWorkflowPlugin()` and query the `usage` Collection through
the ordinary scoped Collections API.

## How it works

The Collection stores normalized attribution, token, cost, and status fields
with indexes for common analytics dimensions.
