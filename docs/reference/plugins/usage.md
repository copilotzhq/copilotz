---
title: "usage"
description: "Usage: what was used, what it cost, and what to charge for it, as a ledger."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# usage

Usage: what was used, what it cost, and what to charge for it, as a ledger.

```ts
import { usage } from "copilotz/plugins/billing";
```

## What it keeps

It keeps 3 collections.

| Collection    | Kept as                             | Fields                                                                                                                                         |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage`       | records, appended and never changed | `meter`, `subject`, `catalog`, `quantities`, `tags`, `cost`, `price`, `costs`, `prices`, `saved`, `rated`, `unpriced`, `adjusts`, `kind`, `at` |
| `usageClosed` | documents                           | `records`, `groups`, `shape`, `at`                                                                                                             |
| `usageRollup` | documents                           | `day`, `meter`, `subject`, `catalog`, `tags`, `kind`, `unpriced`, `quantities`, `cost`, `price`, `costs`, `prices`, `saved`, `rated`, `n`      |

Its named queries read for callers, as the rules let them:

| Query          | Who outside runs it                            |
| -------------- | ---------------------------------------------- |
| `usage.list`   | the app's code                                 |
| `usage.totals` | people, agents for a person, keys and routines |

## What it lets callers do

Of its 7 Actions, people and agents may call 3; contacts and someone signed out may call none.

| Action           | Person | Agent | Contact | Anyone | Key | What it does                                                                                                                                                               |
| ---------------- | ------ | ----- | ------- | ------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage.activity` | yes    | yes   | no      | no     | yes | What was done, newest first (agents' turns, computers' sessions, apps' days), with what each was charged: everyone's for the org's owners and admins, your own for others. |
| `usage.org`      | yes    | yes   | no      | no     | yes | Usage totals across the whole org, for its owners and admins; your own for others.                                                                                         |
| `usage.quote`    | yes    | yes   | no      | no     | yes | What a use would be charged now (its price), without recording it.                                                                                                         |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Only the app's own code calls `usage.close`, `usage.quotes`, `usage.record` and `usage.rerate`: its
plugins, its schedules and the system.

## Where it shows

It has no Views of its own: its front ends show it, [`usage-terminal`](usage-terminal.md) and
[`usage-web`](usage-web.md).

- **What it adds to resources:** `modelUse` (`ledger`).

## What it needs

You set it in `resources.usage`: 2 settings are required.

| Setting            | Type         | Required | What it is                                                                                                                         |
| ------------------ | ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `usage.rollups`    | `Rollups`    | yes      | How whole days are rolled up, so totals over many days read each day's groups rather than its records.                             |
| `usage.categories` | `Categories` | yes      | What each category holds (see shared/categories.ts).                                                                               |
| `usage.priceList`  | `string`     | no       | Whoever keeps an org's plan: the Action naming its price list among `resources.priceLists` (none: `resources.price`).              |
| `usage.spent`      | `string`     | no       | The Action told what each use was charged (`{ price }`), before it's recorded, so what's left is known without reading the ledger. |

It also reads `cost`, `price`, `priceLists` and `usageNames`, resource kinds the app and other
plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.45`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `usage.close` calls `usage.close`, cron 10 0 * * * (UTC).

## Listing

It keeps every listing rule.
