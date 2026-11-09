---
title: "credits-web"
description: "Credits' web front end: the org page's Billing section (the web shell's `orgSettings`)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# credits-web

Credits' web front end: the org page's Billing section (the web shell's `orgSettings`).

```ts
import { creditsWeb } from "copilotz/plugins/billing/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `billing.composer`, `billing.org`.
- **What it adds to resources:** `composerNotes` (`billing`), `orgSettings` (`billing`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It moves to its own package, `@copilotz/billing`, for `copilotz` `^1.0.0-rc.32`. Until then, it
ships in `copilotz`.

## Listing

It keeps every listing rule.
