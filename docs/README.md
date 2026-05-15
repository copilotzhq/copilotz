---
title: Copilotz Docs
description: Build production AI apps from declared resources instead of assembling infrastructure by hand.
section: Home
order: 0
status: stable
---

# Copilotz Docs

Copilotz is the full-stack framework for AI applications.

LLM wrappers give you chat. Copilotz gives you the application layer around it:
agents, tools, memory, RAG, assets, background jobs, multi-tenancy, channels,
app endpoints, and persistent data in one runtime.

The goal is simple: build AI apps, not AI infrastructure.

## How to Read These Docs

Start with the mental model before copying code.

1. [What Is Copilotz?](./start-here/what-is-copilotz.md)
2. [Quickstart](./start-here/quickstart.md)
3. [First Principles](./start-here/first-principles.md)
4. [Choose the Right Primitive](./start-here/choose-the-right-primitive.md)

Then move into the section that matches what you are building:

- use [Build Guides](./build-guides/terminal-chat-with-run.md) when you want a
  task-based path
- use [Core Concepts](./core-concepts/resources.md) when the framework
  vocabulary is unclear
- use [Runtime](./runtime/runs.md) when you need to understand execution
- use [Resources](./resources/resource-types.md) when you are declaring project
  capabilities
- use [Reference](./reference/create-copilotz.md) when you need exact API
  contracts

## The One-Sentence Model

Declare resources, create a Copilotz instance, send messages through `run`, and
let the event runtime connect agents, tools, memory, data, assets, and app
endpoints.

## Current Docs Status

This is a fresh documentation tree. The previous docs were moved to `_old_docs/`
so they can be mined during migration without remaining the public source of
truth.
