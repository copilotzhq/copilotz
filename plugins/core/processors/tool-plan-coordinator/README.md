# Tool Plan Coordinator Processor

## What it is

The durable scheduler and projection authority for Tool-plan branches.

## Why it exists

Parallel Tools, pipelines, retries, and crash recovery require explicit cursors
and one fan-in barrier.

## How to use it

It is installed by Core and reacts to Tool-plan Collection command events.

## How it works

It claims ready stages, dispatches each Action once, advances settled branches,
and elects one final projector.
