---
title: "spaces-terminal"
description: "Access's terminal front end: how spaces look there, and `/spaces`, `/space`, `/work`, `/invite`, `/invitations`, `/accept`, `/decline`, and requests to join."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# spaces-terminal

Access's terminal front end: how spaces look there, and `/spaces`, `/space`, `/work`, `/invite`,
`/invitations`, `/accept`, `/decline`, and requests to join.

```ts
import { accessTerminal } from "copilotz/plugins/access/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show in the terminal.

- **In the terminal:** `terminal.spaces`.
- **What it adds to resources:** `commands` (`/accept`, `/agent`, `/agents`, `/decline`, `/default`,
  `/deny`, `/grant`, `/invitations`, `/invite`, `/remove`, `/requests`, `/space`, `/spaces`,
  `/work`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`spaces`](spaces.md) and [`terminal-shell`](terminal-shell.md):
add them too.

It ships with `copilotz@1.0.0-rc.45`.

## Listing

It keeps every listing rule.
