---
title: "stripe"
description: "Stripe: one way an org pays, for `credits`, which never asks it anything."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# stripe

Stripe: one way an org pays, for `credits`, which never asks it anything.

```ts
import { stripe } from "@copilotz/billing";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Of its 4 Actions, people may call 2; agents, contacts and someone signed out may call none.

| Action             | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                           |
| ------------------ | ------ | ----- | ------- | ------ | --- | ------- | ---------------------------------------------------------------------- |
| `billing.checkout` | yes    | no    | no      | no     | no  | no      | A page where the org buys credits, or subscribes to a plan.            |
| `billing.portal`   | yes    | no    | no      | no     | no  | no      | A page where the org manages what it pays: card, invoices, cancelling. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `billing.sellable` and `stripe.seats`: its plugins, its schedules and
the system.

## Where it shows

It has no Views: it shows nowhere on its own.

- **What it adds to resources:** `billing` (`pay`).

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

The runtime doesn't start without [`credits`](credits.md): add it too.

It ships in a package of its own, `@copilotz/billing@1.0.0-rc.47`, for `copilotz` `1.0.0-rc.47`:
install it beside `copilotz`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `stripe.seats` calls `stripe.seats`, cron 40 0 * * * (UTC). Brings a subscription's seats to the
  org's people, each day.

## Listing

It keeps every listing rule.
