---
title: Memory and Context
description: How Copilotz composes raw history, long-term checkpoints, participant memory, retrieval, skills, and assets into model context.
section: Core Concepts
order: 60
status: stable
---

# Memory and Context

Memory in Copilotz is not one database record or one prompt section. It is a set
of context sources with different scopes and lifecycles.

The goal is not merely to store information. The goal is to put the right
information in front of the model without making every request grow forever.

## Context sources

| Source                        | Scope                      | Best for                                                                |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Thread history                | One thread                 | Exact recent conversation                                               |
| Long-term conversation memory | One thread                 | Bounded continuity across a long-running conversation                   |
| Participant memory            | One participant            | Preferences and facts that should follow a person across threads        |
| Retrieval-backed knowledge    | Configured knowledge space | Documents and external reference material                               |
| Skills                        | Agent or application       | Procedural instructions loaded when needed                              |
| Assets                        | Thread or application      | Persistent files and media referenced without embedding raw binary data |
| Tools and application data    | Defined by the application | Current authoritative state fetched on demand                           |

These sources complement each other. Long-term memory is not a replacement for
RAG, and RAG is not a replacement for recent conversation.

## Thread history

Thread history is the most direct form of memory. Reuse the same `thread.id` or
`thread.externalId` to continue a conversation.

Raw history preserves exact wording, tool calls, and conversational order. It is
therefore the best source for the latest turns. Its weakness is growth: sending
the complete thread on every request eventually becomes expensive and reaches
the model's context limit.

## Long-term conversation memory

Long-term conversation memory bounds a growing thread using checkpoints.

The model sees:

```text
stable agent context
+ latest ready long-term-memory checkpoint
+ recent raw messages after that checkpoint
```

When recent visible history reaches `triggerEstimatedTokens`, Copilotz reserves a
checkpoint for a dedicated non-blocking memory queue. While it is pending, the
existing raw history remains available until the checkpoint is ready. The
checkpoint retains a configured newest-message tail and consolidates the older
range in the background.

The checkpoint combines:

- a current work-state summary;
- newly extracted immutable memory items;
- relevant older items retrieved by embedding similarity;
- graph relations between those items.

Raw messages remain stored. Only the prompt representation changes.

This design keeps a stable prompt prefix between rollovers, preserves source
provenance, and gives the recent conversation room to grow again.

See
[Long-Term Conversation Memory](../getting-started/part-6-memory/14-graph-memory.md)
for configuration and operational guidance, and
[Long-Term Conversation Memory V1](./long-term-memory-v1.md) for the processor
and graph-node contract.

## Participant memory

Participant memory stores useful facts about a sender or user independently of
one thread.

Use it for information such as:

- communication preferences;
- stable profile facts;
- user-specific instructions;
- details that should be available in a future conversation.

Do not use thread long-term memory as a substitute for participant memory.
Thread checkpoints contain shared history for that thread and may include
project-specific state that should not follow a participant everywhere.

## Retrieval-backed knowledge

Retrieval-backed memory uses documents and chunks to provide relevant external
knowledge. This is the RAG path:

```text
ingest document
-> split into chunks
-> embed chunks
-> retrieve relevant chunks
-> include them in model context
```

Use RAG for product documentation, policies, manuals, research, and other source
material whose lifecycle is independent of a conversation.

Long-term conversation memory also uses embeddings, but for a different purpose:
it retrieves prior memory items from the current thread's memory space.

## Skills

Skills are instruction bundles. They provide procedural knowledge without
putting every workflow into the permanent agent prompt.

Skills answer “how should the agent perform this kind of work?” Memory usually
answers “what happened, what is known, and what matters now?”

## Assets

Assets store files and media outside message text. Lightweight `asset://`
references can remain in history while binary content is resolved only when a
model or tool needs it.

This protects both raw history and long-term-memory consolidation from enormous
base64 payloads.

## Model input budgeting

The final request can include several context sources:

```text
agent instructions and tool definitions
+ long-term checkpoint
+ participant and application context
+ retrieved knowledge
+ recent message history
```

`limitEstimatedInputTokens` is the final estimated request budget. It preserves
the system context and trims older raw history only at complete message/tool
cycle boundaries. The boundary is persisted per thread, agent, provider, and
model so sequential prompts retain a stable cacheable prefix.

Memory-specific settings determine what each source contributes. For example:

- `maxContentEstimatedTokens` bounds the long-term checkpoint;
- `retainRecentEstimatedTokens` controls the raw tail after rollover;
- RAG retrieval limits bound document chunks;
- asset references keep binary content out of text history.

Configure these together. No individual source can know the complete budget of
the others.

## Choosing the right primitive

Use thread history when exact recent wording matters.

Use long-term conversation memory when one thread must continue beyond a
practical raw-history window.

Use participant memory when information belongs to a person rather than a
thread.

Use RAG when the source is a document or external knowledge collection.

Use a collection or tool when the information is authoritative application state
that should be queried rather than remembered.

## Related pages

- [Long-Term Conversation Memory](../getting-started/part-6-memory/14-graph-memory.md)
- [Long-Term Conversation Memory V1](./long-term-memory-v1.md)
- [RAG](../getting-started/part-6-memory/12-rag.md)
- [Threads and Messages](./threads-and-messages.md)
- [Resource Types](../resources/resource-types.md)
- [Data and Tenancy](./data-and-tenancy.md)
