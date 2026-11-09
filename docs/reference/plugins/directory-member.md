---
title: "directory-member"
description: "`member(dir, org)`: the plugin each org's runtime gets from the directory (`dir`, its runtime) that serves it, beside the app's own plugins."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# directory-member

`member(dir, org)`: the plugin each org's runtime gets from the directory (`dir`, its runtime) that
serves it, beside the app's own plugins.

The directory gives each org's runtime this plugin: `directory.member(dir, org)`. This page
describes it for an org named Acme.

```ts
import { directory } from "@copilotz/directory";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

It answers 1 route over HTTP:

| Method | Path     |
| ------ | -------- |
| POST   | `/enter` |

## Where it shows

It has no Views: it shows nowhere on its own.

- **What it adds to resources:** `cookies` (`names`, `suffix`), `directory` (`cancel`, `claimCode`,
  `claimHost`, `invite`, `invites`, `leave`, `releaseHost`, `rename`), `org` (`base`, `id`, `kind`,
  `name`), `page` (`base`).

## What it needs

Nothing to set. It reads `hosts`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships in a package of its own, `@copilotz/directory@1.0.0-rc.32`, for `copilotz` `1.0.0-rc.32`:
install it beside `copilotz`.

## Listing

It breaks 1 listing rule as it is:

- Route "/enter" isn't under /directory-member.
