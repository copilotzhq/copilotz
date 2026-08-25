# Persistent Terminal Action

## What it is

The configurable durable Action behind a Persistent Terminal Tool.

## Why it exists

Terminal execution and Asset publication need Action lifecycle, cancellation,
and idempotency semantics.

## How to use it

The plugin factory creates it from a `PersistentTerminalService` and Tool alias.

## How it works

It delegates commands to the service, resolves input Assets, prepares output
Assets, validates results, and materializes staged content atomically.
