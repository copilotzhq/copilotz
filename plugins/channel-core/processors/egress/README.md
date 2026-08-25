# Channel egress processor

## What it is

Delivers prepared intents through an external channel adapter.

## Why it exists

Network retries must not repeat durable graph planning.

## How to use it

Compose `channelsPlugin` with a resource whose egress is `external` and a
deliver-capable adapter.

## How it works

It invokes egress, resolves content, then calls the provider adapter with the
stable delivery key.
