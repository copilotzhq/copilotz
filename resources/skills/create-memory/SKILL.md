---
name: create-memory
description: Add a memory resource that controls history, participant recall, or retrieval-backed context.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, memory, context]
---

# Create Memory

Use a memory resource when conversational context, participant recall, or
retrieval-backed context should be enabled as a first-class Copilotz runtime
capability.

## When To Use It

- Use `memory` for runtime context composition such as history, participant
  memory, or retrieval-backed memory strategies.
- Prefer `configure-rag` when the task is enabling document ingestion and search
  behavior end to end.
- Do not put memory orchestration logic directly inside processors when it
  belongs in a reusable memory resource/runtime boundary.

## Directory Structure

```txt
resources/memory/{memory-name}.ts
```

Also declare the memory resource in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    memory: ["history"],
  },
};
```

## Minimal Example

```typescript
import type { MemoryResource } from "@copilotz/copilotz";

const historyMemory: MemoryResource = {
  name: "history",
  kind: "history",
  description:
    "Conversation history memory that formats prior messages and applies history-window policies.",
  enabled: true,
};

export default historyMemory;
```

## Common Memory Kinds

- `history`: controls conversation-history contribution and truncation behavior
- `participant`: enables participant-bound memory such as user identity or agent
  recall
- `retrieval`: enables retrieval-backed context composition over the
  graph-backed corpus

## How Copilotz Consumes It

- memory resources are loaded from `resources/memory/`
- the runtime memory layer checks enabled memory resources to decide which
  memory contributions to compose into each LLM request
- processors should orchestrate around the memory runtime rather than owning the
  memory implementation details themselves

## Common Mistakes

- Treating memory as just another processor instead of a reusable runtime
  resource
- Mixing operational thread state with memory behavior
- Forgetting to declare the memory resource in `resources/manifest.ts`

## Notes

- Retrieval memory can still be backed by the existing graph `document` and
  `chunk` nodes.
- If you need ingestion/search tools too, pair this with `configure-rag`.
