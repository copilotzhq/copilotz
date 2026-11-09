---
title: "contacts"
description: "Contacts: people outside the org who talk to its agents, such as a WhatsApp customer writing to a business's number."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# contacts

Contacts: people outside the org who talk to its agents, such as a WhatsApp customer writing to a
business's number.

```ts
import { contacts } from "copilotz/plugins/access";
```

## What it keeps

It keeps 1 collection, on the record: every change to it is an event.

| Collection | Kept as   | Fields                    |
| ---------- | --------- | ------------------------- |
| `contact`  | documents | `in`, `via`, `name`, `at` |

The access rules cover `contact`: each document is in a space, and only those who reach the space
reach it.

Its named queries read for callers, as the rules let them:

| Query           | Who outside runs it                            |
| --------------- | ---------------------------------------------- |
| `contact.names` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 3 Actions, people may call 1; agents, contacts and someone signed out may call none.

| Action           | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                           |
| ---------------- | ------ | ----- | ------- | ------ | --- | ------- | ---------------------------------------------------------------------- |
| `contact.forget` | yes    | no    | no      | no     | no  | no      | Erases a contact: its access, its record, and with `chats`, its chats. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `contact.chat` and `contact.start`: its plugins, its schedules and the
system.

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show to the model.

- **To the model:** `context:contact`.
- **Front ends:** [`contacts-web`](contacts-web.md).
- **What it adds to resources:** `context` (`contact`), `names` (`contact`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`spaces`](spaces.md): add it too.

It ships with `copilotz@1.0.0-rc.33`.

## Listing

It keeps every listing rule.
