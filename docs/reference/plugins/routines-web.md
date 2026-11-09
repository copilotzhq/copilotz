---
title: "routines-web"
description: "Routines' web front end, for the browser."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# routines-web

Routines' web front end, for the browser.

```ts
import { routinesWeb } from "copilotz/plugins/agents/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `routine`, `routine.new`, `routine.palette`, `routine.step`, `routines`.
- **What it adds to resources:** `palette` (`routines`), `spaceTabs` (`routines`), `toolViews`
  (`schedule_routine`).

## What it needs

Nothing to set. It reads `routinePanels`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
