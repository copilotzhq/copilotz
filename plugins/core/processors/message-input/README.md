# Message Input Processor

## What it is

The durable ingress bridge from a typed Core Message input to Core storage
Actions.

## Why it exists

Application ingress should use the same transactional Message write and
recipient membership rules as internal workflows.

## How to use it

Install `corePlugin`, then send a `message(...)` input envelope with
`application.send(...)`. A string Thread reference must already exist. An object
reference such as `{ externalId: "hello" }` creates the Thread on first use and
reuses it afterward. An explicit `{ id: "thread-id" }` preserves that record ID
when it creates the Thread.

## How it works

The Processor resolves Thread and Participant references in the current
namespace. Recipient IDs can select existing Participants or configured Agent
aliases and IDs. It creates canonical Agent Participants for registered Agents
and enrolls selected Participants with the sender in the same message write.
Unknown recipients on object Thread references are checked before a new Thread
is created. The message write remains idempotent through the Core
`createThreadMessage` Action.
