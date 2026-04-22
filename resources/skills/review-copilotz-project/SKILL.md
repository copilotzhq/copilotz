---
name: review-copilotz-project
description: Review a Copilotz project for resource-boundary issues, missing capabilities, and likely risks.
allowed-tools: [read_file, search_files, list_directory, persistent_terminal]
tags: [execution, review, architecture]
---

# Review Copilotz Project

Use this skill when the task is to assess a Copilotz project rather than to
immediately implement changes.

## Goal

Identify the highest-value findings first:

- bugs and regressions
- boundary mistakes
- missing tests
- missing capabilities
- docs or examples that mislead the runtime user

## Review Workflow

1. Identify the product surface:
   - who uses it
   - what runs in production
   - what examples or flows matter most
2. Inspect architecture:
   - resource boundaries
   - loader wiring
   - runtime invariants
3. Inspect execution:
   - examples
   - tests
   - docs that claim certain behavior
4. Prioritize findings by severity and likely user impact.

## Focus Areas

- features vs tools vs processors ownership
- thread/history/routing correctness
- skill, docs, and manifest consistency
- test coverage around real usage paths

## Common Mistakes

- Producing broad commentary instead of concrete findings
- Ignoring doc/runtime mismatches
- Treating a missing example or missing test as harmless when it hides
  regressions

## Related Skills

- Use `debug-runtime-issue` when one specific failure is already known.
- Use `refactor-resource-architecture` when the review identifies systemic
  boundary issues.
