---
title: "team"
description: "Team: agents people make, beside those the app declares in code."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# team

Team: agents people make, beside those the app declares in code.

```ts
import { team } from "@copilotz/team";
```

## What it keeps

It keeps 1 collection, on the record: every change to it is an event.

| Collection | Kept as   | Fields                                                                                      |
| ---------- | --------- | ------------------------------------------------------------------------------------------- |
| `agent`    | documents | `name`, `description`, `instructions`, `model`, `effort`, `tools`, `icon`, `in`, `by`, `at` |

The access rules cover `agent`: each document is in a space, and only those who reach the space
reach it.

Its named queries read for callers, as the rules let them:

| Query           | Who outside runs it                            |
| --------------- | ---------------------------------------------- |
| `agent.known`   | people, agents for a person, keys and routines |
| `agent.options` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 5 Actions, people may call 4; agents may call 1; contacts and someone signed out may call
none.

| Action         | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                       |
| -------------- | ------ | ----- | ------- | ------ | --- | ------- | ---------------------------------------------------------------------------------- |
| `agent.create` | yes    | no    | no      | no     | no  | no      | Makes an agent, where you say; it's called by a name made from what it's shown as. |
| `agent.delete` | yes    | no    | no      | no     | no  | no      | Removes an agent people made, from everywhere it works.                            |
| `agent.draft`  | yes    | yes   | no      | no     | yes | yes     | Writes instructions for an agent from its name and what it should do.              |
| `agent.update` | yes    | no    | no      | no     | no  | no      | Changes an agent people made: what it's shown as, does, is told, uses.             |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `agent.define`: its plugins, its schedules and the system.

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views of its own: its front ends show it, [`team-web`](team-web.md).

- **What it adds to resources:** `agentSources` (`team`).

## What it needs

Nothing to set. It reads `agents`, `model` and `tools`, resource kinds the app and other plugins
fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md): add it too.

It ships in a package of its own, `@copilotz/team@1.0.0-rc.45`, for `copilotz` `1.0.0-rc.45`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
