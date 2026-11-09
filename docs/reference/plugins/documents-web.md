---
title: "documents-web"
description: "Documents' web front end, for the browser."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# documents-web

Documents' web front end, for the browser.

```ts
import { documentsWeb } from "@copilotz/work/web";
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

It ships in a package of its own, `@copilotz/work@1.0.0-rc.32`, for `copilotz` `1.0.0-rc.32`:
install it beside `copilotz`.

## Listing

It keeps every listing rule.
