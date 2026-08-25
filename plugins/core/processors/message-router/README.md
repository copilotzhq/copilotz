# Message Router Processor

## What it is

Routes canonical Messages to their recipient Agents.

## Why it exists

Agent turns need durable prompt construction and LLM invocation.

## How to use it

It is installed by `corePlugin` and reacts to `message.created`.

## How it works

It builds participant-relative history, resolves
instructions/models/tools/context, and invokes `llm.call` idempotently.
