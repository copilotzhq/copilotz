---
title: "boards-web"
description: "Boards' web front end, for the browser."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# boards-web

Boards' web front end, for the browser.

```ts
import { boardsWeb } from "copilotz/plugins/work/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `board`, `board.inline`, `board.step`, `boards.palette`, `boards.tab`.
- **What it adds to resources:** `palette` (`boards`), `spaceTabs` (`board`), `toolViews`
  (`create_board`, `create_card`, `list_boards`, `move_card`, `read_board`, `update_card`).

## What it needs

Nothing to set. It reads `boardsText`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It moves to its own package, `@copilotz/work`, for `copilotz` `^1.0.0-rc.31`. Until then, it ships
in `copilotz`.

## Listing

It keeps every listing rule.
