---
title: "Ch 2: Your First Tool"
description: "Add one supplied tool and grant it to the assistant explicitly."
section: Getting Started
order: 20
status: stable
---

# Chapter 2: Your First Tool

> **Part 1 — Foundations**

## The pain

An assistant can answer from the conversation and its training data, but it
cannot know the current time unless it can call something that reads a clock.

## The smallest useful change

Register Copilotz's built-in current-time Tool Resource and grant its alias to
the assistant. This helper is exported from the built-in tools entrypoint; it
does not require a channel or a web-tools plugin.

Add this import to `assistant.ts`:

```ts
// Import only the built-in time capability from its owning plugin entrypoint.
import { getCurrentTimeToolResource } from "@copilotz/copilotz/tools/builtin";
```

Inside the existing `resources` object, add this sibling property next to
`llmConnections` and `agents`:

```ts
// Register the built-in Tool Resource under the alias the agent will be granted.
tools: {
  // Keep the alias consistent with both the Resource's Action and the agent grant.
  get_current_time: getCurrentTimeToolResource,
},
```

Replace the existing `assistant` Resource with this version so it receives the
tool grant:

```ts
// Declare the same agent identity and add its exact allowed tool alias.
assistant: {
  // Keep the identity used by message routing.
  id: "assistant",
  // Keep the readable conversation label.
  name: "Notes assistant",
  // Tell the model when the time capability is relevant.
  role: "A helpful assistant that can check the current time.",
  // Keep selecting a model from the connection configured in Chapter 1.
  models: {
    // Use the existing ordered generation-model list.
    generate: [{
      // Refer to the existing provider connection by name.
      connection: "openai",
      // Keep the selected text-generation model.
      model: "gpt-5.4-mini",
    }],
  },
  // Grant this agent the one Tool Resource registered above.
  capabilities: { tools: ["get_current_time"] },
},
```

In the existing `message()` call, replace the `content` property with this
value, then run `assistant.ts` again. The tool reads the local clock, so this
example needs no extra service or credential beyond the model connection:

```ts
// Ask the assistant to use the current-time capability.
content: "What is the current time?",
```

## Breaking it down

The Resource alias `get_current_time` is the name the agent grant refers to.
Registering a Tool makes it available to the composed application; it does not
grant every agent access. `capabilities.tools` is the assistant's explicit
allowlist.

The built-in Tool Resource is a Core-compatible presentation of an Action. In
the next chapter, you will write an application Action yourself and let the
assistant use it through the same Tool interface.

## What this unlocks

- A model can request a real application capability instead of guessing.
- Tool access stays explicit for each agent.
- A supplied tool can be selected from its plugin entrypoint without importing
  an entire integration stack.

## What's next

A clock is useful, but a notes assistant needs to save information the rest of
the application can use. In
[Chapter 3: Application Data and Actions](./03-application-data-and-actions.md),
create one Collection and one Action, then present that Action as a tool.
