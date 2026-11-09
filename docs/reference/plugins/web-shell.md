---
title: "web-shell"
description: "The web shell: the web's root View, which the web host observes for the address it's at (`hosts/web`)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# web-shell

The web shell: the web's root View, which the web host observes for the address it's at
(`hosts/web`).

```ts
import { webShell } from "copilotz/plugins/interfaces/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `console`, `org`, `web.default`, `web.shell`.

## What it needs

Nothing to set. It reads `orgSettings`, `palette`, `panel`, `sidebar` and `userMenu`, resource kinds
the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
