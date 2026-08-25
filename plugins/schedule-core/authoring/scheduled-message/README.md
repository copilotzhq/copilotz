# Scheduled Message Authoring

## What it is

Public helpers and contracts for typed Core scheduled-message jobs.

## Why it exists

Applications need a safe way to author payloads that the Schedule Core bridge
can recognize and dispatch.

## How to use it

Call `scheduledMessageJob(...)`, or normalize and inspect an equivalent plain
job payload with the exported helpers.

## How it works

The helpers validate the payload discriminator and descriptors, preserve durable
content references, and derive a typed occurrence from a due Event.
