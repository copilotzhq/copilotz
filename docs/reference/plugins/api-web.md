---
title: "api-web"
description: "The developer API's web front end, for the browser."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# api-web

The developer API's web front end, for the browser.

```ts
import { apiWeb } from "copilotz/plugins/interfaces/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `api.keys`, `api.members`, `api.palette`.
- **What it adds to resources:** `apiPresets` (`chat`, `read`), `palette` (`api`), `spaceMembers`
  (`api`), `spaceTabs` (`api`).

## What it needs

Nothing to set. It reads `apiPresets`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`api`](api.md) and [`web-shell`](web-shell.md): add them too.

It ships with `copilotz@1.0.0-rc.45`.

## Listing

It keeps every listing rule.
