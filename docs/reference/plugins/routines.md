---
title: "routines"
description: "Routines: a message sent to an agent on a schedule, in a space (\"every weekday at 9:00, ask @researcher for the news on X\")."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# routines

Routines: a message sent to an agent on a schedule, in a space ("every weekday at 9:00, ask
@researcher for the news on X").

```ts
import { routines } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 2 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                                                                                                           |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routine`    | documents | `in`, `name`, `text`, `agent`, `schedule`, `post`, `thread`, `chatName`, `paused`, `by`, `rev`, `at`, `updated`, `next`, `since`, `last`, `runs` |
| `routineRun` | documents | `routine`, `in`, `at`, `due`, `outcome`, `thread`, `message`, `error`, `note`, `by`                                                              |

The access rules cover `routine` and `routineRun`: each document is in a space, and only those who
reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query          | Who outside runs it                            |
| -------------- | ---------------------------------------------- |
| `routine.list` | people, agents for a person, keys and routines |
| `routine.runs` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 8 Actions, people and agents may call 6; contacts and someone signed out may call none.

| Action           | Person | Agent | Contact | Anyone | Key | What it does                                                             |
| ---------------- | ------ | ----- | ------- | ------ | --- | ------------------------------------------------------------------------ |
| `routine.create` | yes    | yes   | no      | no     | yes | Makes a routine: a message sent to an agent on a schedule, in a space.   |
| `routine.delete` | yes    | yes   | no      | no     | yes | Deletes a routine; the chats it posted in stay.                          |
| `routine.pause`  | yes    | yes   | no      | no     | yes | Pauses a routine: it doesn't run until it's resumed.                     |
| `routine.resume` | yes    | yes   | no      | no     | yes | Resumes a paused routine: it runs on its schedule again, from now.       |
| `routine.run`    | yes    | yes   | no      | no     | yes | Runs a routine now: its message goes to its agent at once.               |
| `routine.update` | yes    | yes   | no      | no     | yes | Changes a routine: its name, message, agent, schedule or where it posts. |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Only the app's own code calls `routine.fire` and `routine.origin`: its plugins, its schedules and
the system.

Agents act through its 4 tools, as whoever they work for:

| Tool               | What it does                                                                                                                                                                                                                                                                                    | Calls            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `cancel_routine`   | Delete one of this space's routines, by its [id] (from list_routines) or its name.                                                                                                                                                                                                              | `routine.delete` |
| `list_routines`    | The routines in this space: what each sends, to whom, when it runs next.                                                                                                                                                                                                                        |                  |
| `name_chat`        | Name this chat for what you found, once you have: people pick a run from a list by its name ("Nov 2 · Competitor cut 8%, we hold").                                                                                                                                                             |                  |
| `schedule_routine` | Make a routine: a message sent to an agent on a schedule, here, as the person you work for ("every weekday at 9:00, ask @researcher for the news on X", "remind me every Monday to send the report"). text is what's sent each time, written as the person would ask it; agent defaults to you. | `routine.create` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It shows to the model through its tools.

- **Agents' tools:** `cancel_routine`, `list_routines`, `name_chat`, `schedule_routine`.
- **Front ends:** [`routines-web`](routines-web.md).
- **What it adds to resources:** `origins` (`routine`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
