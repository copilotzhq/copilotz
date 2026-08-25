# Core Collections

## What it is

The durable conversation storage boundary shared by Core applications.

## Why it exists

Collection mutation and typed input projection are useful independently from LLM
routing and higher-level agent semantics.

## How to use it

Install `coreCollectionsPlugin` when a host needs Core Threads, Participants,
Messages, Tool-plan records, and their domain Actions without semantic routing.

## How it works

Native Actions mutate five Collections transactionally. The Message input
Processor turns the public input envelope into the same idempotent domain write
used by semantic Core.
