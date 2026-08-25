# Message Input Processor

## What it is

The durable ingress bridge from a typed Core Message input to the storage
Action.

## Why it exists

Application ingress should use the same transactional Message write as internal
workflows.

## How to use it

Install Core Collections and send a `message(...)` input envelope.

## How it works

It resolves Thread and Participant external IDs, derives default agent
recipients, and invokes `createThreadMessage` idempotently.
