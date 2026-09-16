# Pause Space Jobs

## What it is

A Schedule Core Processor for conversation attachment moves and removals.

## Why it exists

A job stays owned by its Space when its target conversation moves elsewhere.

## How to use it

The generated Schedule Core plugin registers it automatically.

## How it works

It pages through job attachments, checks current ownership and pauses affected
jobs with a durable reason. Delivery independently checks ownership inside the
message transaction, so queued messages cannot cross the boundary while this
Processor is pending. Core Space primitives contain no scheduling policy.
