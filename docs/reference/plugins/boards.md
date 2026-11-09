---
title: "boards"
description: "Boards: kanban boards in a space, for people and agents, the team's operational source of truth: one real outcome per card, with its owner, what done looks like, an honest column, and any blocker."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# boards

Boards: kanban boards in a space, for people and agents, the team's operational source of truth: one
real outcome per card, with its owner, what done looks like, an honest column, and any blocker.

```ts
import { boards } from "copilotz/plugins/work";
```

## What it keeps

It keeps 2 collections, each on the record: every change to one is an event.

| Collection | Kept as   | Fields                                                                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `board`    | documents | `in`, `name`, `description`, `columns`, `archived`, `by`, `at`, `updatedBy`, `updated`                                    |
| `card`     | documents | `in`, `board`, `column`, `order`, `title`, `description`, `assignee`, `labels`, `due`, `by`, `at`, `updatedBy`, `updated` |

The access rules cover `board` and `card`: each document is in a space, and only those who reach the
space reach it.

## What it lets callers do

Of its 7 Actions, people and agents may call all 7; contacts and someone signed out may call none.

| Action         | Person | Agent | Contact | Anyone | Key | What it does                                                                                       |
| -------------- | ------ | ----- | ------- | ------ | --- | -------------------------------------------------------------------------------------------------- |
| `board.create` | yes    | yes   | no      | no     | yes | Makes a board in a space, with the usual columns unless given its own.                             |
| `board.delete` | yes    | yes   | no      | no     | yes | Deletes a board, with its cards.                                                                   |
| `board.update` | yes    | yes   | no      | no     | yes | Changes a board: its name, description, columns, or whether it's archived.                         |
| `card.create`  | yes    | yes   | no      | no     | yes | Adds a card to a board: a title, and maybe its column, description, assignee, labels and due date. |
| `card.delete`  | yes    | yes   | no      | no     | yes | Deletes a card.                                                                                    |
| `card.move`    | yes    | yes   | no      | no     | yes | Moves a card: to a column, before or after another card, or to its top or bottom.                  |
| `card.update`  | yes    | yes   | no      | no     | yes | Changes a card: its title, description, assignee, labels or due date (null clears).                |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Agents act through its 6 tools, as whoever they work for:

| Tool           | What it does                                                                                                                                                                                            | Calls          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `create_board` | Make a board in this space, for work that takes more than one step.                                                                                                                                     | `board.create` |
| `create_card`  | Add a card to a board in this space: one real outcome, with its owner (assignee), what done looks like and any blocker in its description, and an honest column.                                        | `card.create`  |
| `list_boards`  | List the boards in this conversation's space: each one's name, link, and how many cards are in each column.                                                                                             |                |
| `move_card`    | Move a card in this space (by its id from read_board, or its title) to a column of its board, by the column's name or id: when its state changes, not later.                                            | `card.move`    |
| `read_board`   | Read a board in this space (by its name or id; without one, the space's first): its columns in order, with their cards, each with its id, title, owner, labels, due date and a line of its description. |                |
| `update_card`  | Change a card in this space (by its id from read_board, or its title): its title, description, assignee, labels (the whole set) or due date.                                                            | `card.update`  |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It shows to the model through its tools.

- **Agents' tools:** `create_board`, `create_card`, `list_boards`, `move_card`, `read_board`,
  `update_card`.
- **Front ends:** [`boards-web`](boards-web.md).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`spaces`](spaces.md): add them too.

It moves to its own package, `@copilotz/work`, for `copilotz` `^1.0.0-rc.32`. Until then, it ships
in `copilotz`.

## Listing

It keeps every listing rule.
