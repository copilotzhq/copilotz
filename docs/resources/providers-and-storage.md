---
title: Providers and Storage
description: LLM, embedding, storage, memory, skills, APIs, and MCP resource families.
section: Resources
order: 70
status: draft
---

# Providers and Storage

Copilotz keeps provider infrastructure behind resource boundaries.

## LLM Providers

LLM provider resources let the runtime call models from providers such as
OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, and Minimax.

## Embedding Providers

Embedding providers generate vectors for retrieval and RAG workflows.

## Storage Adapters

Storage adapters persist assets. Built-in options include filesystem, memory,
passthrough, and S3-compatible storage.

## API Resources

API resources describe external HTTP APIs. Copilotz can expose operations from
those APIs as model-callable tools.

## MCP Servers

MCP server resources connect external MCP capabilities.

## Skills and Memory

Skill resources add procedural instructions. Memory resources contribute
conversation, participant, and retrieval context.

## Related Pages

- [Memory and Context](../core-concepts/memory-and-context.md)
- [Assets and Media](../runtime/assets-and-media.md)
