# Run-now Input Processor

## What it is

This Processor routes manual Scheduled Job input envelopes to the run-now
Action.

## Why it exists

Application ingress remains an opaque durable Event until a semantic plugin
validates and invokes its owned Action.

## How to use it

Compose `schedulesPlugin` and send `runScheduledJobNow(...)`.

## How it works

It validates the durable object payload and invokes the Action with a stable
operation key.
