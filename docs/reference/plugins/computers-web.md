---
title: "computers-web"
description: "Computers' web front end, for the browser."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# computers-web

Computers' web front end, for the browser.

```ts
import { computersWeb } from "copilotz/plugins/compute/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `computer`, `computer.ask`, `computer.palette`, `computer.routine`,
  `computer.space`, `computer.step`, `env.space`.
- **What it adds to resources:** `askViews` (`destroy`, `jobs`, `publish`, `terminal`, `writes`),
  `palette` (`computers`), `routinePanels` (`computers`), `spaceTabs` (`computer`, `env`),
  `toolViews` (`browser`, `edit_file`, `job_logs`, `list_files`, `list_jobs`, `read_file`,
  `start_job`, `stop_job`, `terminal`, `web_search`, `write_file`).

## What it needs

Nothing to set. It reads `computerKinds`, `envActions` and `jobActions`, resource kinds the app and
other plugins fill.

## What it requires

The runtime doesn't start without [`computers`](computers.md) and [`web-shell`](web-shell.md): add
them too.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
