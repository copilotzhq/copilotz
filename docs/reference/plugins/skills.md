---
title: "skills"
description: "Skills: know-how an agent reads only when it needs it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# skills

Skills: know-how an agent reads only when it needs it.

```ts
import { skills } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 2 collections, each on the record: every change to one is an event.

| Collection  | Kept as   | Fields                                                              |
| ----------- | --------- | ------------------------------------------------------------------- |
| `skill`     | documents | `in`, `name`, `description`, `size`, `files`, `by`, `at`, `updated` |
| `skillFile` | documents | `skill`, `in`, `path`, `text`                                       |

The access rules cover `skill` and `skillFile`: each document is in a space, and only those who
reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query         | Who outside runs it                            |
| ------------- | ---------------------------------------------- |
| `skill.files` | people, agents for a person, keys and routines |
| `skill.list`  | people, agents for a person, keys and routines |
| `skill.read`  | people, agents for a person, keys and routines |

## What it lets callers do

Of its 3 Actions, people and agents may call all 3; contacts and someone signed out may call none.

| Action         | Person | Agent | Contact | Anyone | Key | What it does                                                             |
| -------------- | ------ | ----- | ------- | ------ | --- | ------------------------------------------------------------------------ |
| `skill.create` | yes    | yes   | no      | no     | yes | Makes a skill in a space: know-how its agents read when a task needs it. |
| `skill.delete` | yes    | yes   | no      | no     | yes | Deletes a skill, with its files.                                         |
| `skill.update` | yes    | yes   | no      | no     | yes | Changes a skill: its name, when it's for, its instructions, its files.   |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Agents act through its tool, as whoever they work for:

| Tool         | What it does                                                                                                                 | Calls |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| `read_skill` | Read one of your skills (listed under Skills in your instructions): what to do, step by step, for the kind of task it's for. |       |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model.

- **To the model:** `context:skills`.
- **Agents' tools:** `read_skill`.
- **Front ends:** [`skills-web`](skills-web.md).
- **What it adds to resources:** `context` (`skills`).

## What it needs

Nothing to set. It reads `skills`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md): add it too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
