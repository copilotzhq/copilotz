---
title: "skills-web"
description: "Skills' web front end, for the browser."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# skills-web

Skills' web front end, for the browser.

```ts
import { skillsWeb } from "copilotz/plugins/agents/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `skill`, `skill.new`, `skill.palette`, `skill.step`, `skills`.
- **What it adds to resources:** `palette` (`skills`), `spaceTabs` (`skills`), `toolViews`
  (`read_skill`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
