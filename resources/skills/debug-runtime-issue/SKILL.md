---
name: debug-runtime-issue
description: Reproduce, inspect, isolate, and verify fixes for Copilotz runtime problems.
allowed-tools: [read_file, search_files, persistent_terminal, list_directory]
tags: [execution, debugging, runtime]
---

# Debug Runtime Issue

Use this skill when behavior is wrong, missing, looping, failing silently, or
otherwise not matching the intended runtime flow.

## Goal

Find the real failure mode and verify the fix rather than stopping at a
plausible explanation.

## Workflow

1. Reproduce the issue:
   - failing example
   - test
   - thread history
   - runtime logs
2. Locate the owning path:
   - loader
   - processor
   - tool call
   - LLM invocation
   - database or collection operations
3. Inspect the state that explains the failure:
   - stored thread or participant data
   - metadata and routing state
   - tool outputs
   - event sequencing
4. Form one root-cause hypothesis at a time and validate it.
5. After editing, rerun the narrowest useful reproduction and at least one
   adjacent regression check.

## Debugging Heuristics

- Silent failures often hide inside background processors or swallowed
  exceptions.
- Conversation bugs often require checking persisted state, not just prompts.
- Multi-agent issues usually need both history generation and routing
  inspection.

## Common Mistakes

- Guessing at prompt issues before checking stored state and runtime flow
- Fixing the symptom in history rendering while breaking persistence invariants
- Declaring success without rerunning the original reproduction

## Related Skills

- Use `review-copilotz-project` for broader risk assessment after the bug is
  fixed.
- Use `refactor-resource-architecture` if the bug comes from the wrong primitive
  owning behavior.
