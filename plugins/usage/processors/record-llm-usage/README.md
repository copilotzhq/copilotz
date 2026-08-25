# Record LLM Usage Processor

## What it is

This Processor projects finalized `llm.call` attempts into Usage records.

## Why it exists

Recovered, failed, and successful provider requests each need independent,
idempotent accounting rather than one misleading aggregate row.

## How to use it

Compose the Usage plugin. Its factory supplies the configured accounting policy
to this Processor.

## How it works

It recognizes durable LLM lifecycle and accounting-progress events, resolves
participant attribution, and persists one stable row per provider attempt.
