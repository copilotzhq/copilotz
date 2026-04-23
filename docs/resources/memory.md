# Memory

Memory resources define how Copilotz recalls context for agents and
conversations.

## Where It Lives

```txt
resources/memory/<memory-name>.ts
resources/memory/mod.ts
```

## What It Is For

Use a memory resource when you want to shape contextual recall rather than
define a new tool, collection, or processor.

Recommended use case: participant memory, history recall, retrieval-backed
context

Most common mistaken alternative: putting recall logic directly in
`processors/new_message`

## How Copilotz Consumes It

- memory resources are loaded into the runtime memory registry
- the memory runtime uses them to assemble participant memory, history, and
  retrieval-backed context
- user identity binding also flows through the memory runtime boundary

## Built-in Memory Resources

- `participant` — agent learnings and participant-backed memory
- `history` — conversation history recall and history-window behavior
- `retrieval` — graph-backed document and chunk retrieval for contextual
  injection

## Public Surface

Memory resources are runtime-facing. They shape prompt/context composition
rather than exposing a transport endpoint directly.

## Related Pages

- [Agents](../agents.md)
- [RAG](../rag.md)
- [Resources](./README.md)
