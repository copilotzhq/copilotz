---
title: "usage-web"
description: "Usage's web front end: where the app serves many orgs, the org page's Usage section (the web shell's `orgSettings`)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# usage-web

Usage's web front end: where the app serves many orgs, the org page's Usage section (the web shell's
`orgSettings`).

```ts
import { usageWeb } from "copilotz/plugins/billing/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `usage.org`.
- **What it adds to resources:** `orgSettings` (`usage`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
