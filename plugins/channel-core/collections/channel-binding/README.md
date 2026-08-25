# Channel binding collection

## What it is

Stores the external-thread to Core-thread mapping for a channel alias.

## Why it exists

Ingress and egress need a durable provider routing coordinate.

## How to use it

Compose `channelsPlugin`; use its indexed queries from channel
actions/processors.

## How it works

The collection is unique per channel alias and external thread ID.
