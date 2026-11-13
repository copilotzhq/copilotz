---
title: "computers-terminal"
description: "Computers' terminal front end: `/computers` and `/computer`."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# computers-terminal

Computers' terminal front end: `/computers` and `/computer`.

```ts
import { computersTerminal } from "copilotz/plugins/compute/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

It has no Views: it shows nowhere on its own.

- **What it adds to resources:** `commands` (`/computer`, `/computers`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`computers`](computers.md) and
[`terminal-shell`](terminal-shell.md): add them too.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
