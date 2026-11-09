---
title: "team-web"
description: "Team's web front end, for the browser: making and changing agents."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# team-web

Team's web front end, for the browser: making and changing agents.

```ts
import { teamWeb } from "@copilotz/team/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `agent`, `agent.add`, `agent.palette`, `model.pick`.
- **What it adds to resources:** `palette` (`agents`), `spaceInvite` (`agents`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`team`](team.md) and [`web-shell`](web-shell.md): add them too.

It ships in a package of its own, `@copilotz/team@1.0.0-rc.33`, for `copilotz` `1.0.0-rc.33`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
