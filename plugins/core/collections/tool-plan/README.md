# Tool Plan Collection

## What it is

The immutable Tool-plan header and single fan-in projection barrier.

## Why it exists

Parallel branch progress lives in independent `toolPlanBranch` records so one
branch can advance without rewriting sibling cursors. The parent header keeps
the provider plan snapshot and projection ownership state.

## How to use it

Core's Tool-plan Processor drives its commands; applications normally inspect it
only for diagnostics.

## How it works

The coordinator creates the header and branch records atomically. Each branch
claims stages, settles immutable result references, and advances its own cursor.
The parent barrier opens only after every branch is final, then elects one
projection owner.
