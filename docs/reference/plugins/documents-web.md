---
title: "documents-web"
description: "Documents' web front end, for the browser."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# documents-web

Documents' web front end, for the browser.

```ts
import { documentsWeb } from "copilotz/plugins/work/web";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Nobody calls it: it has no Actions, tools or routes.

## Where it shows

Its Views show on the web.

- **On the web:** `document`, `document.history`, `document.palette`, `document.read`,
  `document.step`, `document.version`, `documents`.
- **What it adds to resources:** `palette` (`documents`), `spaceTabs` (`documents`), `toolViews`
  (`append_document`, `edit_document`, `list_documents`, `read_document`, `write_document`).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`web-shell`](web-shell.md): add it too.

It moves to its own package, `@copilotz/work`, for `copilotz` `^1.0.0-rc.31`. Until then, it ships
in `copilotz`.

## Listing

It keeps every listing rule.
