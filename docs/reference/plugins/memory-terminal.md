---
title: "memory-terminal"
description: "Memory's terminal front end: how a memory looks there, and `/memories`."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# memory-terminal

Memory's terminal front end: how a memory looks there, and `/memories`.

```ts
import { memoryTerminal } from "copilotz/plugins/agents/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show in the terminal.

- **In the terminal:** `terminal.memory`.
- **What it adds to resources:** `commands` (`/memories`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`memory`](memory.md) and [`terminal-shell`](terminal-shell.md):
add them too.

It ships with `copilotz@1.0.0-rc.45`.

## Listing

It keeps every listing rule.
