---
title: "usage-terminal"
description: "Usage's terminal front end: how totals look there, and `/usage`."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# usage-terminal

Usage's terminal front end: how totals look there, and `/usage`.

```ts
import { usageTerminal } from "copilotz/plugins/billing/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show in the terminal.

- **In the terminal:** `usage.totals`.
- **What it adds to resources:** `commands` (`/usage`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`usage`](usage.md) and [`terminal-shell`](terminal-shell.md): add
them too.

It ships with `copilotz@1.0.0-rc.34`.

## Listing

It keeps every listing rule.
