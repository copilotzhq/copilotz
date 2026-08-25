# Knowledge plugin

## What it is

A first-party plugin for ingesting, indexing, searching, and deleting scoped
knowledge documents.

## Why it exists

It provides durable document lifecycle state, background indexing, and
model-facing search without making the runtime own RAG semantics.

## How to use it

Compose `createKnowledgePlugin` with an embedding provider and optionally
customize source loading, extraction, chunking, and generated tool aliases.

## How it works

The plugin stores documents and chunks in Collections, starts indexing from a
durable processor, resolves embeddings through a resource boundary, and
generates matching Actions and Tool Resources.
