# Message Router Processor

## What it is

Routes canonical Messages to their recipient Agents.

## Why it exists

Agent turns need durable prompt construction and LLM invocation.

## How to use it

It is installed by `corePlugin` and reacts to `message.created`.

## How it works

It builds participant-relative history, resolves an Agent's dynamic instructions
and model routes inside one read-only snapshot, then resolves tools/context and
invokes `llm.call` idempotently.

If preparation exhausts its delivery retries before the LLM Action starts,
`onError` settles an owned Ask through the same deferred Tool-plan mechanism as
an LLM failure. Temporary preparation failures retain normal retries; unrelated
or unauthorized failures retain dead-letter handling.
