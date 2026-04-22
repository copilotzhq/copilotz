---
name: ship-chat-experience
description: Connect chat UI, adapters, backend features, and runtime behavior into one product flow.
allowed-tools: [read_file, write_file, search_files, list_directory]
tags: [execution, chat, ui]
---

# Ship Chat Experience

Use this skill when the task spans both the Copilotz runtime and the user-facing
chat experience.

## Goal

Deliver a coherent chat product flow instead of isolated backend or UI changes.

## Workflow

1. Define the user-visible chat behavior:
   - conversation start
   - message send/receive
   - loading, errors, and special states
   - thread continuity
2. Choose the right backend resources:
   - `feature` for app-facing actions
   - `tool` for agent-invoked capabilities
   - `channel` for transport integration
   - `processor` for event-driven flow
3. Use the UI skills where relevant:
   - `configure-chat-ui`
   - `advanced-chat-features`
4. Verify the end-to-end path:
   - request reaches runtime
   - runtime emits the expected event stream
   - UI renders the expected state

## Design Heuristics

- Keep app-facing contracts stable and explicit.
- Avoid leaking raw runtime internals into the frontend unless they are part of
  the product design.
- Treat special states, auth, and bootstrap flows as first-class UX behavior.

## Common Mistakes

- Building UI and runtime separately without validating the stream contract
- Using tools for frontend contracts that should be features
- Treating chat configuration as purely visual when runtime state flow is still
  broken

## Related Skills

- Use `implement-feature` for the backend change set.
- Use `build-copilotz-system` when the chat surface is only one part of a larger
  system.
