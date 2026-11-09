---
title: "memory"
description: "Memory: what agents know across conversations."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# memory

Memory: what agents know across conversations.

```ts
import { memory } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 2 collections, 1 of them on the record.

| Collection       | Kept as   | Fields                                                                                                   |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `memory`         | documents | `text`, `about`, `core`, `in`, `by`, `source`, `was`, `at`, `updated`, `forgotten`; vectors: `embedding` |
| `memoryProgress` | documents | `pending`                                                                                                |

The access rules cover `memory`: each document is in a space, and only those who reach the space
reach it.

Its named queries read for callers, as the rules let them:

| Query             | Who outside runs it                            |
| ----------------- | ---------------------------------------------- |
| `memory.core`     | the app's code                                 |
| `memory.list`     | people, agents for a person, keys and routines |
| `memory.relevant` | the app's code                                 |

## What it lets callers do

Of its 2 Actions, people may call 1; agents, contacts and someone signed out may call none.

| Action        | Person | Agent | Contact | Anyone | Key | Routine | What it does                     |
| ------------- | ------ | ----- | ------- | ------ | --- | ------- | -------------------------------- |
| `memory.move` | yes    | no    | no      | no     | no  | no      | Moves a memory to another space. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `memory.import`: its plugins, its schedules and the system.

Agents act through its 3 tools, as whoever they work for:

| Tool       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                    | Calls |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `forget`   | Forget a memory that is wrong or no longer wanted, by its [id].                                                                                                                                                                                                                                                                                                                                                                 |       |
| `recall`   | Search what you remember, by meaning and by words: about the people here, yourself, this conversation and everyone.                                                                                                                                                                                                                                                                                                             |       |
| `remember` | Remember something worth knowing in later conversations: one self-contained statement naming who it is about, and why it matters if that isn't obvious. about: the person it concerns, by name (by default, the person you're talking with), "me" for a note to yourself, "thread" for this conversation only, or "everyone". core: true for what you should always have in mind about them (who they are, strong preferences). |       |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model.

- **To the model:** `context:memory`, `context:recall`, `context:remembered`, `llm.memory`.
- **Agents' tools:** `forget`, `recall`, `remember`.
- **Front ends:** [`memory-terminal`](memory-terminal.md) and [`memory-web`](memory-web.md).
- **What it adds to resources:** `context` (`memory`, `recall`, `remembered`).

## What it needs

You set it in `resources.memory`.

| Setting            | Type       | Required | What it is                                                                                           |
| ------------------ | ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `memory.embedder`  | `ModelRef` | no       | An embeddings model (`"provider/model"`, …), for semantic recall; without one, recall matches words. |
| `memory.extractor` | `ModelRef` | no       | A model (`"provider/model"`, …) that extracts memories from conversations on its own.                |
| `memory.every`     | `number`   | no       | Shared messages per extraction (8).                                                                  |
| `memory.agents`    | `string[]` | no       | The agents with memory (all by default).                                                             |

## What it requires

The runtime doesn't start without [`chat`](chat.md): add it too.

It ships with `copilotz@1.0.0-rc.33`.

## Listing

It keeps every listing rule.
