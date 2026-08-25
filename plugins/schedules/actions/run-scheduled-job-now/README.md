# Run Scheduled Job Now Action

## What it is

This Action manually claims one occurrence of an existing Scheduled Job.

## Why it exists

Applications need a durable manual-run path that uses the same occurrence and
deduplication rules as clock-driven scheduling.

## How to use it

Send `runScheduledJobNow(...)` after composing `schedulesPlugin`.

## How it works

The Action validates the job and timestamp, derives a stable occurrence ID, and
invokes the Scheduled Job Collection's `due` command.
