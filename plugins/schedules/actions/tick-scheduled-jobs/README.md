# Tick Scheduled Jobs Action

## What it is

This Action scans and claims Scheduled Jobs that are due at a supplied time.

## Why it exists

Clock delivery must become durable, tenant-scoped Collection commands before
semantic plugins perform scheduled work.

## How to use it

Send `scheduleTick(...)` after composing `schedulesPlugin`.

## How it works

The Action pages active jobs, orders due candidates deterministically, and
claims each occurrence through the Collection's idempotent `due` command.
