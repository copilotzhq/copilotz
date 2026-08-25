# Create Thread Message Action

## What it is

The canonical atomic write for a Core Message and its sender membership.

## Why it exists

Content materialization, Participant creation, Message creation, and membership
must not partially commit.

## How to use it

Invoke `createThreadMessage` with a deterministic Message ID, Thread, sender,
recipients, and content.

## How it works

It prepares content, resolves the sender, and applies all Collection mutations
in one transaction with routing and visibility metadata.
