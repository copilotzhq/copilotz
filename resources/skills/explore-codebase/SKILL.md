---
name: explore-codebase
description: Discover repo structure, entrypoints, architecture, and likely implementation targets before editing.
allowed-tools: [list_directory, search_files, read_file, persistent_terminal]
tags: [execution, discovery, architecture]
---

# Explore Codebase

Use this skill when the task is not yet implementation-ready and you need to
understand where behavior lives before making changes.

## Goal

Produce a grounded implementation map:

- the relevant repo or package
- likely entrypoints
- key runtime boundaries
- the smallest safe write surface for the change

## Workflow

1. Start with the most local source of truth:
   - workspace skill or repo descriptor
   - `README.md`, `REPO.md`, `AGENTS.md`
   - resource or runtime docs
2. Identify the likely subsystem:
   - agent behavior
   - tool execution
   - feature endpoints
   - processors/events
   - collections/data
   - channels/transports
3. Trace the execution path:
   - entrypoint
   - loader/registration
   - runtime consumer
   - tests that exercise the path
4. Summarize:
   - what files are likely relevant
   - what primitive owns the behavior
   - what should not be touched

## Output Format

When handing findings back to yourself or another agent, include:

- current behavior
- likely implementation target
- important constraints
- open uncertainty that still needs validation

## Common Mistakes

- Starting edits before confirming the owning primitive
- Treating docs and runtime as interchangeable without tracing the actual code
  path
- Exploring the whole repo when the task only touches one subsystem

## Related Skills

- Use `implement-feature` once the implementation target is clear.
- Use `refactor-resource-architecture` when the problem is boundary confusion.
