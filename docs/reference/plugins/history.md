---
title: "history"
description: "Summarizes each thread's older messages as they leave its tail, and sends agents the outline and the recent messages whole (it replaces chat's `history` View)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# history

Summarizes each thread's older messages as they leave its tail, and sends agents the outline and the
recent messages whole (it replaces chat's `history` View).

```ts
import { history } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 2 collections, 1 of them on the record.

| Collection | Kept as   | Fields                                                                                                                |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `outline`  | documents | `count`, `lines`, `bytes`, `boundary`, `since`, `tail`, `tailAt`, `tailIds`, `tailSteps`, `last`, `complete`, `cutAt` |
| `summary`  | documents | `thread`, `level`, `index`, `text`, `bytes`, `message`, `at`                                                          |

Its named queries read for callers, as the rules let them:

| Query        | Who outside runs it |
| ------------ | ------------------- |
| `summary.of` | the app's code      |

## What it lets callers do

Agents act through its tool, as whoever they work for:

| Tool   | What it does                                                                                                                                                                | Calls |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `zoom` | Open a line of the summarized conversation: zoom(id, n) with the line's id+n gives the two lines it was made from (n/2 messages each); zoom(id, 1) gives the message whole. |       |

## Where it shows

Its Views show elsewhere.

- **Elsewhere:** `history`, `history.since`, `summary`.
- **Agents' tools:** `zoom`.

## What it needs

You set it in `resources.history`: 4 settings are required.

| Setting              | Type               | Required | What it is                                                                                                                                                                                |
| -------------------- | ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history.summarizer` | `ModelRef`         | yes      | The model that writes summary lines (`"provider/model"`, …): a fast, cheap one does well.                                                                                                 |
| `history.line`       | `number`           | yes      | A line's size limit, in UTF-8 bytes (512: a dense paragraph).                                                                                                                             |
| `history.tail`       | `[number, number]` | yes      | Whole messages at the end, by what they cost a prompt (estimated tokens: text, files, tool steps): they grow to the second, then the oldest leave (shared ones as lines) until the first. |
| `history.outline`    | `[number, number]` | yes      | The outline: it grows to the second size, then the most due pairs merge until the first (bytes).                                                                                          |

Until it's set, the runtime doesn't start. With nothing set, its check says: "history: set the
history resource's summarizer model."

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`models`](models.md): add them too.

It ships with `copilotz@1.0.0-rc.32`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `history.compact` runs on `message.created`.
- `history.erase` runs on `thread.deleted`.

## Listing

It keeps every listing rule.
