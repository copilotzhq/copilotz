---
title: "web-page"
description: "The page: the app's code, its files, its manifest and worker, and the page itself."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# web-page

The page: the app's code, its files, its manifest and worker, and the page itself.

```ts
import { webPage } from "copilotz/web/server";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

It answers 5 routes over HTTP:

| Method | Path                    |
| ------ | ----------------------- |
| GET    | `/*`                    |
| GET    | `/app/*`                |
| ANY    | `/assets{/*}?`          |
| GET    | `/manifest.webmanifest` |
| GET    | `/sw.js`                |

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.page`: 1 setting is required.

| Setting       | Type                    | Required | What it is                                                                                                                                                                                                              |
| ------------- | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.code`   | `Code \| (function)`    | yes      | The browser's code, bundled (or a function that bundles it, once): the app's front ends.                                                                                                                                |
| `page.title`  | `string`                | no       | The browser's code, bundled (or a function that bundles it, once): the app's front ends.                                                                                                                                |
| `page.lang`   | `string`                | no       | The page's language (`pt-BR`), for browsers, readers and translators: English unless said.                                                                                                                              |
| `page.assets` | `Record<string, Asset>` | no       | The app's own files, by the path each is served at, under `/assets/` (`{ "/assets/fonts/brand.css": bytes }`): content, or a function that reads it, once.                                                              |
| `page.base`   | `string`                | no       | Where the app is under its host, when it isn't the root (an org's `/o/<org>`): the runtime answers there too, and the page tells its code (`appBase()`), so its `/connect`, its socket and the addresses it shows work. |

Until it's set, the runtime doesn't start. With nothing set, its check says: "webPage serves the
page's code: set page.code."

It also reads `theme`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It breaks 5 listing rules as it is:

- Route "/*" isn't under /web-page.
- Route "/app/*" isn't under /web-page.
- Route "/assets{/*}?" isn't under /web-page.
- Route "/manifest.webmanifest" isn't under /web-page.
- Route "/sw.js" isn't under /web-page.
