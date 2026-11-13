---
title: "stripe-webhook"
description: "Stripe's webhook, `POST /__stripe/<seller>`, where the app's accounts send their events (see routes/webhook.ts)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# stripe-webhook

Stripe's webhook, `POST /__stripe/<seller>`, where the app's accounts send their events (see
routes/webhook.ts).

```ts
import { stripeWebhook } from "@copilotz/billing";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `stripe.fact`: its plugins, its schedules and the
system. Nobody outside does.

It answers 1 route over HTTP:

| Method | Path                |
| ------ | ------------------- |
| POST   | `/__stripe/:seller` |

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.stripe`: 3 settings are required.

| Setting          | Type                     | Required | What it is                                                                                                                            |
| ---------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe.sellers` | `Record<string, Seller>` | yes      | The accounts, by name, and the one that sells unless a country says otherwise.                                                        |
| `stripe.seller`  | `string`                 | yes      | The accounts, by name, and the one that sells unless a country says otherwise.                                                        |
| `stripe.url`     | `string`                 | yes      | The app's address, for coming back from checkout.                                                                                     |
| `stripe.live`    | `boolean`                | no       | Real money: a test mode's customers and subscriptions don't carry over.                                                               |
| `stripe.orgs`    | `object`                 | no       | Where the webhook finds an org's runtime, in an app of many (the directory's: its `runtimes`); without it, the webhook's own runtime. |

It also reads `billing` and `org`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships in a package of its own, `@copilotz/billing@1.0.0-rc.45`, for `copilotz` `1.0.0-rc.45`:
install it beside `copilotz`.

## Listing

It breaks 1 listing rule as it is:

- Route "/__stripe/:seller" isn't under /stripe-webhook.
