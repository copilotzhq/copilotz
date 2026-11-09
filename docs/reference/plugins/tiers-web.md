---
title: "tiers-web"
description: "Tiers' web front end, for the browser."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# tiers-web

Tiers' web front end, for the browser.

```ts
import { tiersWeb } from "copilotz/plugins/agents/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `tiers.agent`, `tiers.org`, `tiers.space`.
- **What it adds to resources:** `orgSettings` (`models`), `spaceAgents` (`tiers`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md), [`spaces-web`](spaces-web.md) and
[`team-web`](team-web.md): add them too.

It moves to its own package, `@copilotz/team`, for `copilotz` `^1.0.0-rc.32`. Until then, it ships
in `copilotz`.

## Listing

It keeps every listing rule.
