---
name: implement-feature
description: Turn a product request into the right set of Copilotz and app edits.
allowed-tools: [
  read_file,
  write_file,
  search_files,
  list_directory,
  persistent_terminal,
]
tags: [execution, implementation, feature]
---

# Implement Feature

Use this skill when the user wants a concrete capability built, not just an
explanation or scaffold.

## Goal

Translate a product request into the smallest correct set of edits across
runtime, resources, UI, and tests.

## Workflow

1. Clarify the user-visible behavior:
   - what changes
   - who triggers it
   - what success looks like
2. Choose the owning primitives:
   - `feature` for app-facing contracts
   - `tool` for agent-callable actions
   - `processor` for event-driven behavior
   - `collection` for durable state
   - `channel` for transport integration
3. Reuse the resource skills instead of inventing structure:
   - `create-feature`
   - `create-tool`
   - `setup-collection`
   - `add-processor`
   - `create-channel`
4. Implement end to end:
   - code
   - wiring/registration
   - tests
   - docs or examples if needed
5. Verify the behavior with the narrowest useful test or example run.

## Decision Rules

- If the frontend or service calls it directly, prefer a feature.
- If the model decides whether to call it, prefer a tool.
- If it is mostly data shape and persistence, start with collections.
- If multiple primitives are involved, document the control flow before editing.

## Common Mistakes

- Treating every feature request as a new tool
- Editing only the resource definition and forgetting the runtime consumer
- Skipping tests on cross-resource changes

## Related Skills

- Use `explore-codebase` first if the implementation surface is unclear.
- Use `ship-chat-experience` when the feature spans backend and chat UI.
