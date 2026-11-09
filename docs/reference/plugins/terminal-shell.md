---
title: "terminal-shell"
description: "The terminal's front end, for the process that draws: the `shell` View (what's open, the scrollback, where you type), where you type's prompt, and the View any kind without its own falls back to."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# terminal-shell

The terminal's front end, for the process that draws: the `shell` View (what's open, the scrollback,
where you type), where you type's prompt, and the View any kind without its own falls back to.

```ts
import { terminalShell } from "copilotz/plugins/interfaces/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show in the terminal.

- **In the terminal:** `prompt`, `terminal.default`, `terminal.shell`.

## What it needs

Nothing to set. It reads `notices`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`terminal`](terminal.md): add it too.

It ships with `copilotz@1.0.0-rc.33`.

## Listing

It keeps every listing rule.
