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

Use a processor when the runtime should react to an event.

Examples:

- after `NEW_MESSAGE`, decide whether an agent should respond
- after `TOOL_CALL`, execute the tool
- after `TOOL_RESULT`, add tool output to history
- after a custom event, update analytics

Processors are event pipeline extensions.

## The Boundary

If the model chooses, use a tool.

If the app chooses, use a feature.

If an event should trigger it, use a processor.

## Related Pages

- [Choose the Right Primitive](../start-here/choose-the-right-primitive.md)
- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Build a Feature Endpoint](../build-guides/build-feature-endpoint.md)
