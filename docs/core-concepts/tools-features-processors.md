---
title: Tools, Features, and Processors
description: Tools are agent-owned actions, features are app-owned endpoints, and processors are runtime event handlers.
section: Core Concepts
order: 50
status: stable
---

# Tools, Features, and Processors

Tools, features, and processors all run code, but they have different owners.

## Tools

Use a tool when the agent should decide whether to run the action.

Examples:

- get the current time
- search knowledge
- call a booking API
- save or fetch an asset
- inspect a workspace

Tools are exposed to the model through names, descriptions, and input schemas.
The model chooses when to call them.

## Features

Use a feature when application code should call the behavior directly.

Examples:

- `POST /features/auth/login`
- `POST /features/qa/start`
- `GET /features/admin/overview`
- `POST /features/report/run`

Features have request/response contracts. They are backend endpoints, not model
actions.

## Processors

Use a processor when the runtime should react to a domain lifecycle event.

Examples:

- after `message.created`, decide whether an agent should respond
- after `tool_execution.created`, execute the tool
- after `tool_execution.completed`, expose tool output to history
- after `llm_attempt.failed`, continue from partial reasoning or visible output
- after a custom event, update analytics

Processors are event pipeline extensions. New runtime code should use
`deps.db.ops.mutate.*` to write domain state so the graph mutation and outbox
event commit in one transaction. Returning `producedEvents` is still supported
for legacy custom processors and live stream compatibility, but it is not the
preferred durable workflow primitive.

## The Boundary

If the model chooses, use a tool.

If the app chooses, use a feature.

If an event should trigger it, use a processor.

## Related Pages

- [Choose the Right Primitive](../start-here/choose-the-right-primitive.md)
- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Build a Feature Endpoint](../build-guides/build-feature-endpoint.md)
