---
name: build-copilotz-system
description: Assemble a multi-resource Copilotz application or agent system end to end.
allowed-tools: [
  read_file,
  write_file,
  search_files,
  list_directory,
  persistent_terminal,
]
tags: [execution, system-design, copilotz]
---

# Build Copilotz System

Use this skill when the user is building a real Copilotz project that spans
multiple resources and needs a coherent architecture, not isolated scaffolds.

## Goal

Turn a product idea into a workable Copilotz system design and implementation
path.

## System Design Checklist

For every build, define:

- primary user flows
- agent roles and orchestration
- tools and external integrations
- features and app endpoints
- collections and durable state
- channels and transport requirements
- retrieval, assets, or storage needs
- testing and example flows

## Assembly Workflow

1. Start from the product behavior, not from file generation.
2. Choose the minimal resource graph that supports the behavior.
3. Use the resource skills to implement each part:
   - `create-agent`
   - `create-tool`
   - `create-feature`
   - `setup-collection`
   - `add-processor`
   - `create-channel`
   - `configure-rag`
   - `configure-mcp`
4. Define one end-to-end happy path and one failure path before coding.
5. Validate the assembled system with examples, tests, or a real run.

## Common Mistakes

- Starting from resources instead of user flows
- Over-building multi-agent orchestration before single-agent behavior works
- Treating skills as scaffolds only instead of as architectural guidance

## Related Skills

- Use `review-copilotz-project` after the first working version.
- Use `ship-chat-experience` when the system includes a user-facing chat
  surface.
