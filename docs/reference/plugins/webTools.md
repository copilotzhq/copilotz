---
title: "webTools"
description: "Web tools: agents that search the web and read a page, without a computer."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# webTools

Web tools: agents that search the web and read a page, without a computer.

```ts
import { webTools } from "copilotz/plugins/agents";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Agents act through its 2 tools, as whoever they work for:

| Tool         | What it does                                                              | Calls |
| ------------ | ------------------------------------------------------------------------- | ----- |
| `read_page`  | Reads a web page (http or https): its title, its main text and its links. |       |
| `web_search` | Searches the web.                                                         |       |

Other plugins call it through its adapters: `search` (`duckduckgo`, `fake`, `serper`).

## Where it shows

It shows to the model through its tools.

- **Agents' tools:** `read_page`, `web_search`.
- **What it adds to resources:** `cost` (`duckduckgo`).

## What it needs

You set it in `resources.webTools`.

| Setting                 | Type       | Required | What it is                                                                       |
| ----------------------- | ---------- | -------- | -------------------------------------------------------------------------------- |
| `webTools.search`       | `object`   | no       |                                                                                  |
| `webTools.timeout`      | `number`   | no       | How long a search or a page may take, in ms (15 s).                              |
| `webTools.maxBytes`     | `number`   | no       | The most of a page that is read, in bytes (2 MB); more fails.                    |
| `webTools.pageChars`    | `number`   | no       | How much text one `read_page` answer holds, in characters (20,000).              |
| `webTools.redirects`    | `number`   | no       | How many redirects a page may follow (4).                                        |
| `webTools.readsPerTurn` | `number`   | no       | How many pages one agent turn may read (8).                                      |
| `webTools.ports`        | `number[]` | no       | Ports besides 80 and 443 a page may be fetched on.                               |
| `webTools.userAgent`    | `string`   | no       | The user agent pages are asked with.                                             |
| `webTools.resolve`      | `Resolve`  | no       | Hosts whose addresses are looked up some other way (tests; a resolver over DoH). |

It also reads `spending`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md): add it too.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
