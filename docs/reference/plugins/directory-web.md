---
title: "directory-web"
description: "The directory's web front end, for apps that serve many orgs behind one address: it fills the web shell's `orgs` slot, and draws the org's pages."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# directory-web

The directory's web front end, for apps that serve many orgs behind one address: it fills the web
shell's `orgs` slot, and draws the org's pages.

```ts
import { directoryWeb } from "@copilotz/directory/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `console`, `org`, `orgs.overlay`, `orgs.switcher`.
- **What it adds to resources:** `orgs` (`overlay`, `switcher`, `use`).

## What it needs

Nothing to set. It reads `orgSettings`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It ships in a package of its own, `@copilotz/directory@1.0.0-rc.45`, for `copilotz` `1.0.0-rc.45`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
