---
title: "terminal"
description: "The terminal plugin: a command line's data, built from the same primitives as everything else, which every process has."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# terminal

The terminal plugin: a command line's data, built from the same primitives as everything else, which
every process has.

```ts
import { terminalPlugin } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 2 collections, 1 of them on the record.

| Collection | Kept as                    | Fields                                          |
| ---------- | -------------------------- | ----------------------------------------------- |
| `output`   | in memory, gone on restart | `person`, `text`, `kind`, `item`, `hints`, `at` |
| `shell`    | documents                  | `open`, `listed`, `space`                       |

Its named queries read for callers, as the rules let them:

| Query        | Who outside runs it                          |
| ------------ | -------------------------------------------- |
| `shell.mine` | people, keys or routines, depending on input |

## What it lets callers do

Of its 2 Actions, people may call all 2; agents, contacts and someone signed out may call none.

| Action        | Person  | Agent | Contact | Anyone | Key     | What it does                                                           |
| ------------- | ------- | ----- | ------- | ------ | ------- | ---------------------------------------------------------------------- |
| `shell.print` | depends | no    | no      | no     | depends | Prints text, or an item through its kind's View, on a person's screen. |
| `shell.set`   | depends | no    | no      | no     | depends | Changes a person's shell state: what's open, what was listed.          |

An agent works for a person, and calls what both may. A key calls only what its scope names.
"depends": its `allow` reads the input to decide.

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

Nothing to set: it works as it comes.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
