# Tool Plan Stage Result Collection

## What it is

The immutable, content-backed terminal receipt for one Tool-plan stage.

## Why it exists

Unbounded Action output must not be copied into mutable coordinator state.

## How to use it

Core creates deterministic records per plan, branch, and stage; diagnostics may
query them by plan ID.

## How it works

Each record stores a bounded terminal envelope through the Collection content
field and is referenced by the Tool-plan cursor.
