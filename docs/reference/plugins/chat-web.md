---
title: "chat-web"
description: "Chat's web front end, for the browser: home (a new chat), how a chat looks with what agents are writing right now, a message and its files, where you type, and at the top of the sidebar, starting one."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# chat-web

Chat's web front end, for the browser: home (a new chat), how a chat looks with what agents are
writing right now, a message and its files, where you type, and at the top of the sidebar, starting
one.

```ts
import { chatWeb } from "copilotz/plugins/agents/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `chat.palette`, `chats`, `chats.recent`, `file`, `home`, `new-thread`, `web.live`,
  `web.message`, `web.thread`.
- **What it adds to resources:** `palette` (`chats`), `sidebar` (`start`), `spaceSidebar` (`chats`),
  `spaceTabs` (`chats`), `suggestions` (`draft`, `explain`, `names`, `week`).

## What it needs

Nothing to set. It reads `composerNotes`, `conversation`, `home`, `refusals`, `suggestions` and
`toolViews`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md) and [`web-shell`](web-shell.md): add them too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
