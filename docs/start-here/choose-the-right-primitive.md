---
title: Choose the Right Primitive
description: Decide which Copilotz primitive should own each part of your app.
section: Start Here
order: 40
status: stable
---

# Choose the Right Primitive

Most Copilotz design questions become easier when ownership is clear.

Ask: who should decide when this runs?

## Quick Guide

| Need                                        | Use                         | Why                                          |
| ------------------------------------------- | --------------------------- | -------------------------------------------- |
| Process one inbound user message            | `run`                       | It is the core message execution primitive   |
| Try a local terminal chat                   | `start`                     | It wraps a `run` loop for development        |
| Drive a bounded multi-turn journey          | `goal`                      | It owns the loop, stop rules, and evaluation |
| Let an agent execute an action              | `tool`                      | The agent decides when to call it            |
| Let app code call backend behavior directly | `feature`                   | The app owns the request/response contract   |
| Persist app-specific data                   | `collection`                | Typed CRUD with namespace support            |
| React to runtime events                     | `processor`                 | It extends the event pipeline                |
| Integrate a transport                       | `channel`                   | It maps external ingress/egress to Copilotz  |
| Add model context                           | `memory`, `rag`, or `skill` | They influence what the model sees           |

## Use run

Use `copilotz.run(...)` for one inbound message.

It returns a handle with:

- `events`, an async iterable of runtime events
- `done`, a promise that resolves when processing is complete
- `threadId`, the resolved conversation thread
- `cancel`, a function to stop the run

## Use start

Use `copilotz.start(...)` for local interactive development.

It is not the production chat API. It is a convenient terminal loop built on top
of `run`.

## Use goal

Use `copilotz.goal(...)` when a lead agent should drive a target agent toward a
result over multiple turns.

Good examples:

- synthetic QA
- checkout or onboarding journey tests
- background jobs that need agent-led follow-up
- final judged evaluations

Do not use `goal` for a single message. Use `run`.

## Use a Tool

Use a tool when the agent should decide whether to call the capability.

Examples:

- search an internal knowledge base
- get the current time
- call a booking API
- save an asset
- inspect files in an assistant workspace

Tools are part of the model's action space.

## Use a Feature

Use a feature when frontend or backend code should call the behavior directly.

Examples:

- start login
- complete OAuth callback
- run a report
- trigger a background goal
- fetch product-specific state

Features are app-facing endpoints, not model-owned actions.

## Use a Processor

Use a processor when you need runtime behavior triggered by events.

Examples:

- transform messages after `NEW_MESSAGE`
- handle custom events
- add audit records
- change tool result behavior
- run background ingestion

Processors are the framework extension point for event pipeline behavior.

## Use a Collection

Use a collection for application-specific data.

Collections are available to app code, tools, features, and processors. They are
also namespace-aware, so they fit multi-tenant apps.

## The Useful Rule

If the model chooses when it happens, make it a tool.

If app code chooses when it happens, make it a feature.

If the runtime should react when something happens, make it a processor.
