---
title: "memory-web"
description: "Memory's web front end, for the browser: what agents remember (the `memories` View, as the terminal's `/memories` lists it: ★ for core memories, always in mind)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# memory-web

Memory's web front end, for the browser: what agents remember (the `memories` View, as the
terminal's `/memories` lists it: ★ for core memories, always in mind).

```ts
import { memoryWeb } from "copilotz/plugins/agents/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `memories`, `memory.palette`, `memory.pick`.
- **What it adds to resources:** `palette` (`memory`), `spaceTabs` (`memories`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`memory`](memory.md) and [`web-shell`](web-shell.md): add them
too.

It ships with `copilotz@1.0.0-rc.33`.

## Listing

It keeps every listing rule.
