---
title: "web-lines"
description: "Web sites (`resources.web.<name>`, declared in the app's settings, with the app's secret, `links`)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# web-lines

Web sites (`resources.web.<name>`, declared in the app's settings, with the app's secret, `links`).

```ts
import { webLines } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 2 collections, 1 of them on the record.

| Collection        | Kept as                    | Fields                                                      |
| ----------------- | -------------------------- | ----------------------------------------------------------- |
| `contact_rate`    | in memory, gone on restart | `until`, `count`, `spent`, `holds`, `closed`, `v`           |
| `contact_visitor` | documents                  | `line`, `thread`, `tags`, `spoke`, `ended`, `expires`, `at` |

Its named queries read for callers, as the rules let them:

| Query                   | Who outside runs it |
| ----------------------- | ------------------- |
| `contact_visitor.actor` | the app's code      |

## What it lets callers do

Only the app's own code calls its 5 Actions, `contact.arrive`, `contact.budget`, `contact.prune`,
`contact.sending` and `contact.spent`: its plugins, its schedules and the system. Nobody outside
does.

It answers 1 route over HTTP:

| Method | Path         |
| ------ | ------------ |
| POST   | `/web/:name` |

It also says who a request is (`who`) and adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views: it shows nowhere on its own.

- **What it adds to resources:** `contactSend` (`web`), `modelUse` (`webLines`).

## What it needs

You set it in `resources.web`: 1 setting is required.

| Setting                 | Type                 | Required | What it is                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web.<name>.in`         | `string`             | yes      | The space its visitors' chats live in: one the app declares too (the spaces plugin's `spaces` resource) is made and kept with the site.                                                                                                                                                         |
| `web.<name>.agent`      | `string`             | no       | Who answers its visitors (an agent's name); else whoever answers new chats in the space.                                                                                                                                                                                                        |
| `web.<name>.title`      | `string`             | no       | What its visitors' chats are called, as the space's people see them (the site's name).                                                                                                                                                                                                          |
| `web.<name>.days`       | `number`             | no       | How long a visitor stays the same one (their browser's cookie), in days: 30.                                                                                                                                                                                                                    |
| `web.<name>.limits`     | `Partial<WebLimits>` | no       | How long a visitor stays the same one (their browser's cookie), in days: 30.                                                                                                                                                                                                                    |
| `web.<name>.files`      | `WebFiles`           | no       | Files its visitors may send (none unless said): `{}` for one of 5 MB a message, or how many and how large.                                                                                                                                                                                      |
| `web.<name>.transcribe` | `boolean`            | no       | Whether what visitors' audio files say is transcribed for the agent (a model's call, paid): not unless said.                                                                                                                                                                                    |
| `web.<name>.budget`     | `number`             | no       | What its visitors' model use may be charged a day (UTC), in the usage ledger's prices (the app's currency): what the turns working for them cost, as the usage plugin rates it.                                                                                                                 |
| `web.<name>.challenge`  | `string`             | no       | An Action of the app's that a newcomer must pass to be let in (a CAPTCHA's check: Turnstile's, hCaptcha's): asked as the system with `{ line, answer }`, where `answer` is what the page sent coming in (`web({ arrive: { name, challenge } })`'s `challenge`), it answers true to let them in. |

It also reads `agents`, `caller` and `org`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`contacts`](contacts.md): add it too.

It ships with `copilotz@1.0.0-rc.34`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `web.forget` runs on `contact.deleted`.
- `contact.prune` calls `contact.prune`, every 10m. Drops web visitors' counters and records that
  are past, and contacts never heard.

## Listing

It breaks 1 listing rule as it is:

- Route "/web/:name" isn't under /web-lines.
