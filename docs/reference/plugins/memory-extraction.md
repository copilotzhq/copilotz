---
title: "memory-extraction"
description: "Memories that arrive on their own: the extractor model reads every few messages, and what a conversation said before going quiet."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# memory-extraction

Memories that arrive on their own: the extractor model reads every few messages, and what a
conversation said before going quiet.

```ts
import { memoryExtraction } from "copilotz/plugins/agents";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `memory.extract`: its plugins, its schedules and the
system. Nobody outside does.

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.memory`: 1 setting is required.

| Setting  | Type | Required | What it is                                                    |
| -------- | ---- | -------- | ------------------------------------------------------------- |
| `memory` |      | yes      | memory-extraction: set the memory resource's extractor model. |

Until it's set, the runtime doesn't start. With nothing set, its check says: "memory-extraction: set
the memory resource's extractor model."

## What it requires

The runtime doesn't start without [`memory`](memory.md) and [`models`](models.md): add them too.

It ships with `copilotz@1.0.0-rc.38`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `memory.extract` runs on `message.created`.

## Listing

It keeps every listing rule.
