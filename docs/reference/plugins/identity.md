---
title: "identity"
description: "Identity: who people are and what proves it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# identity

Identity: who people are and what proves it.

```ts
import { identity } from "copilotz/plugins/access";
```

## What it keeps

It keeps 2 collections, each on the record: every change to one is an event.

| Collection   | Kept as   | Fields                                                |
| ------------ | --------- | ----------------------------------------------------- |
| `credential` | documents | `kind`, `person`, `hint`, `expires`, `staff`, `at`    |
| `person`     | documents | `name`, `email`, `picture`, `accounts`, `named`, `at` |

Its named queries read for callers, as the rules let them:

| Query              | Who outside runs it |
| ------------------ | ------------------- |
| `credential.actor` | the app's code      |
| `person.profile`   | the app's code      |

## What it lets callers do

Of its 6 Actions, people may call 2; agents, contacts and someone signed out may call none.

| Action          | Person | Agent | Contact | Anyone | Key | Routine | What it does                                     |
| --------------- | ------ | ----- | ------- | ------ | --- | ------- | ------------------------------------------------ |
| `person.rename` | yes    | no    | no      | no     | no  | no      | Sets the name you go by; an empty one clears it. |
| `session.end`   | yes    | no    | no      | no     | no  | no      | Ends the session whose secret is shown.          |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `credential.revoke`, `person.email`, `person.set` and `session.start`:
its plugins, its schedules and the system.

It answers 2 routes over HTTP:

| Method | Path       |
| ------ | ---------- |
| GET    | `/me`      |
| POST   | `/signout` |

It also says who a request is (`who`) and adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

Nothing to set: it works as it comes.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.45`.

## Listing

It breaks 2 listing rules as it is:

- Route "/me" isn't under /identity.
- Route "/signout" isn't under /identity.
