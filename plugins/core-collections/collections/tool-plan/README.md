# Tool Plan Collection

## What it is

The durable cursor and fan-in barrier for parallel Tool branches.

## Why it exists

Parallel branch progress must survive retries and crashes without duplicating
side effects.

## How to use it

Core's Tool-plan Processor drives its commands; applications normally inspect it
only for diagnostics.

## How it works

Command mutations claim stages, settle immutable result references, advance
branches, and elect one projection owner.
