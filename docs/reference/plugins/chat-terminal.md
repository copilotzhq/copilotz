---
title: "chat-terminal"
description: "Chat's terminal front end, for the process that draws the terminal."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# chat-terminal

Chat's terminal front end, for the process that draws the terminal.

```ts
import { chatTerminal } from "copilotz/plugins/agents/terminal";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show in the terminal.

- **In the terminal:** `agent.prompt`, `approvals`, `author`, `terminal.live`, `terminal.message`,
  `terminal.thread`, `threads`.
- **What it adds to resources:** `commands` (`*`, `/approvals`, `/approve`, `/file`, `/fork`,
  `/history`, `/move`, `/new`, `/notes`, `/open`, `/prompt`, `/retry`, `/stop`, `/threads`),
  `notices` (`approvals`).

## What it needs

Nothing to set. It reads `agents`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`terminal-shell`](terminal-shell.md): add
them too.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
