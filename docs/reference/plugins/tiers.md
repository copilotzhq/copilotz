---
title: "tiers"
description: "Tiers: how hard an app's agents think, chosen by budget rather than model by model."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# tiers

Tiers: how hard an app's agents think, chosen by budget rather than model by model.

```ts
import { tiers } from "@copilotz/team";
```

## What it keeps

It keeps 3 collections, each on the record: every change to one is an event.

| Collection     | Kept as   | Fields                                                         |
| -------------- | --------- | -------------------------------------------------------------- |
| `modelChoice`  | documents | `space`, `thread`, `person`, `tier`, `cap`, `at`               |
| `tierKind`     | documents | `title`, `description`, `base`, `at`                           |
| `tierTemplate` | documents | `title`, `description`, `order`, `agents`, `off`, `made`, `at` |

Its named queries read for callers, as the rules let them:

| Query                 | Who outside runs it                            |
| --------------------- | ---------------------------------------------- |
| `modelChoice.agent`   | people, agents for a person, keys and routines |
| `modelChoice.offered` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 7 Actions, people may call 6; agents, contacts and someone signed out may call none.

| Action          | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                             |
| --------------- | ------ | ----- | ------- | ------ | --- | ------- | ------------------------------------------------------------------------ |
| `tiers.cap`     | yes    | no    | no      | no     | no  | no      | Sets the highest tier the org's members may choose.                      |
| `tiers.choose`  | yes    | no    | no      | no     | no  | no      | Chooses the tier for the org, a space, a conversation or your new chats. |
| `tiers.kind`    | yes    | no    | no      | no     | no  | no      | Adds or renames a kind of work of the org's own.                         |
| `tiers.remove`  | yes    | no    | no      | no     | no  | no      | Takes one of the app's tiers away from the org, or deletes one it made.  |
| `tiers.restore` | yes    | no    | no      | no     | no  | no      | Puts one of the app's tiers back as the app has it.                      |
| `tiers.save`    | yes    | no    | no      | no     | no  | no      | Saves one of the org's tiers: its version of the app's, or a new one.    |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `tiers.model`: its plugins, its schedules and the system.

## Where it shows

It has no Views of its own: its front ends show it, [`tiers-web`](tiers-web.md).

- **What it adds to resources:** `agentModel` (`tiers`).

## What it needs

Nothing to set. It reads `agentSources`, `model`, `planCredits`, `planTier`, `provider`,
`tierKinds`, `tiers`, `typicalMessage` and `usage`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It ships in a package of its own, `@copilotz/team@1.0.0-rc.58`, for `copilotz` `1.0.0-rc.58`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
