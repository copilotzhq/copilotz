# Message Router Processor

## What it is

Routes canonical Messages to their recipient Agents.

## Why it exists

Agent turns need durable prompt construction and LLM invocation.

## How to use it

It is installed by `corePlugin` and reacts to `message.created`.

Explicit recipient IDs address Participants. Only currently readable Agent
recipients start LLM turns. Human, Tool, and Job recipients remain on the stored
Message for conversation and channel delivery; a mixed list starts turns only
for its Agents. Omitted recipients still default to the Thread's Agents.

## How it works

It builds participant-relative history, resolves an Agent's dynamic instructions
and model routes inside one read-only snapshot, then resolves tools/context and
invokes `llm.call` idempotently.

If preparation exhausts its delivery retries before the LLM Action starts,
`onError` settles an owned Ask through the same deferred Tool-plan mechanism as
an LLM failure. Temporary preparation failures retain normal retries; unrelated
or unauthorized failures retain dead-letter handling.

Each Agent recipient has a stable, independent Action identity. Input
preparation is serialized within a routing invocation so snapshot ownership and
compaction remain ordered; provider execution may overlap once the inputs are
captured. The router awaits every recipient's settlement before propagating a
retryable failure. Delivery retries replay completed peers and retry only
unfinished turns.
