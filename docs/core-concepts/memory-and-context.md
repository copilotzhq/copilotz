---
title: Memory and Context
description: Copilotz composes thread history, participant memory, retrieval, skills, and assets into model context.
section: Core Concepts
order: 60
status: draft
---

# Memory and Context

Copilotz gives agents context from several sources.

The goal is not only to store data. The goal is to put the right information in
front of the model at the right time.

## Context Sources

Common context sources include:

- thread history
- participant identity and memory
- retrieval-backed document chunks
- skills loaded for the agent
- asset references and resolved media
- tool results that should be visible in history
- app-specific data loaded by tools or processors

## Thread History

Thread history is the most basic form of memory. Reuse the same `thread.id` or
`thread.externalId` to continue a conversation.

## Participant Memory

Participant memory stores useful facts about the sender or user. Agents can
update memory with native tools, and applications can read/write participant
records through collections or app handlers.

## Retrieval

Retrieval-backed memory uses documents and chunks to add relevant knowledge to a
run. This is the RAG path: ingest documents, embed chunks, search relevant
chunks, and include them in model context.

## Skills

Skills are instruction bundles. They help agents load procedural knowledge
without putting every detail in the main agent prompt.

## Related Pages

- [Threads and Messages](./threads-and-messages.md)
- [Resource Types](../resources/resource-types.md)
- [Data and Tenancy](./data-and-tenancy.md)
