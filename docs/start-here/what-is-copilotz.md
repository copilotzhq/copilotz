---
title: What Is Copilotz?
description: Copilotz is a full-stack framework for production AI applications.
section: Start Here
order: 10
status: stable
---

# What Is Copilotz?

Copilotz is a full-stack framework for AI applications.

An LLM wrapper helps you call a model. Copilotz helps you ship the product
around the model: agents, tools, memory, RAG, assets, background work, channels,
multi-tenancy, app endpoints, and persistent data.

## The Problem

AI apps quickly become infrastructure projects.

You start with chat. Then you need conversation history, user memory, tool
calling, API actions, file handling, vector search, background jobs, cost
tracking, WhatsApp or web channels, tenant isolation, and application-specific
data.

Without a framework, each of those becomes a separate decision and a separate
integration.

## The Copilotz Approach

Copilotz gives you one runtime built around declared resources.

Resources describe what your app can do:

- agents decide and respond
- tools let agents execute actions
- features expose app-owned backend behavior
- collections persist application data
- memory and RAG add context
- channels connect transports like web, WhatsApp, Zendesk, Discord, or Telegram
- processors extend the event pipeline
- providers connect LLMs, embeddings, storage, APIs, and MCP servers

`createCopilotz(...)` loads those resources into a runtime. `copilotz.run(...)`
sends a message through that runtime. Events show what happened.

## What You Build

You build a Copilotz app by answering a few questions:

- who are the agents?
- what can they do?
- what should the app expose directly to users or frontends?
- what data should be persistent?
- how should conversations be identified?
- which channel or UI should deliver messages?

The framework handles the repeatable infrastructure beneath those choices.

## Recommended Use

Use Copilotz when your AI product needs more than a single model call:

- persistent conversations
- tool execution
- user or tenant memory
- RAG and document ingestion
- background workflows
- custom data models
- external channels
- agent evaluation or synthetic QA

If you only need `fetch("https://api.openai.com/...")`, Copilotz may be more
framework than you need. If you are building a real AI application, Copilotz is
designed to be the application layer.

## Next

Continue with [Quickstart](./quickstart.md), then read
[First Principles](./first-principles.md) to understand how `run`, `start`,
threads, events, and tools fit together.
