---
title: "documents"
description: "Documents: shared Markdown in a space, for people and agents — the canonical artifact of the thing being made, and its working memory."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# documents

Documents: shared Markdown in a space, for people and agents — the canonical artifact of the thing
being made, and its working memory.

```ts
import { documents } from "@copilotz/work";
```

## What it keeps

It keeps 3 collections, 2 of them on the record.

| Collection         | Kept as                    | Fields                                                                                                                           |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `document`         | documents                  | `in`, `title`, `text`, `version`, `size`, `createdBy`, `createdAt`, `savedBy`, `savedAt`, `savedFor`                             |
| `documentPresence` | in memory, gone on restart | `document`, `in`, `who`, `state`, `at`                                                                                           |
| `documentVersion`  | documents                  | `document`, `in`, `version`, `title`, `text`, `by`, `for`, `at`, `kind`, `merged`, `base`, `from`, `added`, `removed`, `renamed` |

The access rules cover `document`, `documentPresence` and `documentVersion`: each document is in a
space, and only those who reach the space reach it.

Its named queries read for callers, as the rules let them:

| Query                     | Who outside runs it                            |
| ------------------------- | ---------------------------------------------- |
| `document.list`           | people, agents for a person, keys and routines |
| `document.recent`         | people, agents for a person, keys and routines |
| `documentVersion.history` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 6 Actions, people and agents may call all 6; contacts and someone signed out may call none.

| Action              | Person | Agent | Contact | Anyone | Key | What it does                                                                                                                   |
| ------------------- | ------ | ----- | ------- | ------ | --- | ------------------------------------------------------------------------------------------------------------------------------ |
| `document.create`   | yes    | yes   | no      | no     | yes | Makes a document in a space.                                                                                                   |
| `document.delete`   | yes    | yes   | no      | no     | yes | Deletes a document and its history.                                                                                            |
| `document.presence` | yes    | yes   | no      | no     | yes | Says who has a document open, and whether they're editing it.                                                                  |
| `document.rename`   | yes    | yes   | no      | no     | yes | Renames a document.                                                                                                            |
| `document.restore`  | yes    | yes   | no      | no     | yes | Brings back an old version of a document, as its next version.                                                                 |
| `document.save`     | yes    | yes   | no      | no     | yes | Saves a document's new text (and title) as its next version, merging with what others saved since the version it started from. |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Agents act through its 5 tools, as whoever they work for:

| Tool              | What it does                                                                                                                                                                       | Calls |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `append_document` | Add text to the end of a document of this space (by its title or id), after a blank line.                                                                                          |       |
| `edit_document`   | Change part of a document of this space (by its title or id): replace text that occurs exactly once in it (old, copied exactly, with enough around it to be unique) with new text. |       |
| `list_documents`  | List this space's documents, latest saved first: each one's title (a link to it), version, size, who saved it last and when, and how it opens.                                     |       |
| `read_document`   | Read a document of this space, by its title or id: its text (Markdown), with its version and who saved it.                                                                         |       |
| `write_document`  | Make a new document in this space (title and text), or, naming one with document, replace its whole text (and title, if given).                                                    |       |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It shows to the model through its tools.

- **Agents' tools:** `append_document`, `edit_document`, `list_documents`, `read_document`,
  `write_document`.
- **Front ends:** [`documents-web`](documents-web.md).

## What it needs

Nothing to set. It reads `agents`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It ships in a package of its own, `@copilotz/work@1.0.0-rc.33`, for `copilotz` `1.0.0-rc.33`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
