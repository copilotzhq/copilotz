---
title: "accounts-web"
description: "Connected accounts' web front end, for the browser."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# accounts-web

Connected accounts' web front end, for the browser.

```ts
import { accountsWeb } from "copilotz/plugins/access/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `accounts`, `accounts.palette`, `accounts.uses`.
- **What it adds to resources:** `conversation` (`accounts`), `palette` (`accounts`), `userMenu`
  (`accounts`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`accounts`](accounts.md) and [`web-shell`](web-shell.md): add
them too.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
