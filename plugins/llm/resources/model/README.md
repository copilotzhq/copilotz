# Model resource

## What it is

A validated declaration selecting one built-in provider model or a custom
Adapter model.

## Why it exists

Models keep provider configuration at composition time rather than durable
Action input.

## How to use it

Use `defineModel(...)` when declaring an entry in `resources.models`; plain
compatible objects also work.

## How it works

The helper validates, normalizes, and freezes the declaration; `llm.call`
resolves it when invoked.
