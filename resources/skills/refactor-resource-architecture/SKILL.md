---
name: refactor-resource-architecture
description: Move behavior to the right Copilotz primitive and clean up boundary confusion.
allowed-tools: [read_file, write_file, search_files, list_directory]
tags: [execution, refactor, architecture]
---

# Refactor Resource Architecture

Use this skill when the system works poorly because behavior lives in the wrong
Copilotz primitive or too many concerns are mixed together.

## Goal

Reassign ownership so each concern sits in the right layer:

- `agent` for orchestration and instructions
- `tool` for model-invoked actions
- `feature` for app-facing endpoints
- `processor` for event-driven background flow
- `collection` for durable state
- `channel` for transport boundaries

## Workflow

1. Describe the current ownership problem in one sentence.
2. Identify the better target primitive.
3. Move one responsibility at a time:
   - contracts
   - state
   - side effects
   - transport logic
4. Keep public behavior stable unless the user asked for behavior changes.
5. Add or update tests around the boundary you moved.

## Refactor Signals

Use this skill when you see:

- application endpoints implemented as tools
- transport parsing inside feature handlers
- business logic buried in channels
- persistent state encoded in random metadata instead of collections
- processors doing synchronous request/response work that belongs elsewhere

## Common Mistakes

- Moving code without also moving tests and docs
- Changing multiple boundaries at once without preserving behavior
- Treating resource type changes as mere file moves instead of contract changes

## Related Skills

- Pair with `implement-feature` when the refactor also introduces new behavior.
- Pair with `create-feature`, `create-tool`, or `add-processor` for the new
  target shape.
