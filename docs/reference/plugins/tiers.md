---
title: "tiers"
description: "Tiers: which models the app's agents think with, chosen by what the work needs rather than model by model."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# tiers

Tiers: which models the app's agents think with, chosen by what the work needs rather than model by
model.

```ts
import { tiers } from "copilotz/plugins/agents";
```

## What it keeps

It keeps 1 collection, on the record: every change to it is an event.

| Collection    | Kept as   | Fields                          |
| ------------- | --------- | ------------------------------- |
| `modelChoice` | documents | `space`, `tier`, `custom`, `at` |

Its named queries read for callers, as the rules let them:

| Query                 | Who outside runs it |
| --------------------- | ------------------- |
| `modelChoice.agent`   | people and keys     |
| `modelChoice.offered` | people and keys     |

## What it lets callers do

Of its 3 Actions, people may call 2; agents, contacts and someone signed out may call none.

| Action         | Person | Agent | Contact | Anyone | Key | What it does                                                            |
| -------------- | ------ | ----- | ------- | ------ | --- | ----------------------------------------------------------------------- |
| `tiers.choose` | yes    | no    | no      | no     | no  | Chooses the tier of models the app's agents use, in the org or a space. |
| `tiers.pick`   | yes    | no    | no      | no     | no  | Picks the model one of the app's agents uses, in the org or a space.    |

A key calls what its person may, when its scope names the Action.

Only the app's own code calls `tiers.model`: its plugins, its schedules and the system.

## Where it shows

It has no Views of its own: its front ends show it, [`tiers-web`](tiers-web.md).

- **What it adds to resources:** `agentModel` (`tiers`).

## What it needs

Nothing to set. It reads `agents`, `model`, `planTier`, `provider`, `tiers` and `usage`, resource
kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It moves to its own package, `@copilotz/team`, for `copilotz` `^1.0.0-rc.31`. Until then, it ships
in `copilotz`.

## Listing

It keeps every listing rule.
