---
title: "credits"
description: "Credits: what an org has to spend, and the check that stops it at its limit."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# credits

Credits: what an org has to spend, and the check that stops it at its limit.

```ts
import { credits } from "copilotz/plugins/billing";
```

## What it keeps

It keeps 4 collections, 1 of them on the record.

| Collection    | Kept as                             | Fields                                                                                                                                                                       |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billingPlan` | documents                           | `name`, `terms`, `seats`, `since`, `counting`, `anchor`, `channel`, `seller`, `customer`, `subscription`, `status`, `statusAt`, `ended`, `sandbox`, `budget`, `waived`, `at` |
| `billingRoom` | in memory, gone on restart          | `credits`, `budget`, `limit`, `lowCredits`, `lowBudget`, `until`                                                                                                             |
| `credit`      | records, appended and never changed | `kind`, `amount`, `at`, `expires`, `note`, `reason`, `by`, `takes`, `sandbox`                                                                                                |
| `payment`     | records, appended and never changed | `channel`, `seller`, `ref`, `amount`, `currency`, `rate`, `fee`, `purpose`, `credits`, `note`, `by`, `sandbox`, `at`                                                         |

## What it lets callers do

Of its 16 Actions, people may call 8; agents may call 2; contacts and someone signed out may call
none.

| Action            | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                      |
| ----------------- | ------ | ----- | ------- | ------ | --- | ------- | --------------------------------------------------------------------------------- |
| `billing.budget`  | yes    | no    | no      | no     | no  | no      | Sets the org's limit for a month, or removes it.                                  |
| `billing.grant`   | yes    | no    | no      | no     | no  | no      | Gives the org credits, or takes some away.                                        |
| `billing.notice`  | yes    | yes   | no      | no     | yes | yes     | What to say above the composer about what the org can spend, if anything.         |
| `billing.pay`     | yes    | no    | no      | no     | no  | no      | Keeps money that came in by hand, and the credits it bought.                      |
| `billing.redeem`  | yes    | no    | no      | no     | no  | no      | Adds a gift code's credits to the org.                                            |
| `billing.setPlan` | yes    | no    | no      | no     | no  | no      | Puts the org on a plan, or a contract of its own terms.                           |
| `billing.state`   | yes    | yes   | no      | no     | yes | yes     | Where the org stands: whether it can spend; its plan and credits for who runs it. |
| `billing.waive`   | yes    | no    | no      | no     | no  | no      | Waives the org's usage or seats, or lifts that.                                   |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `billing.apply`, `billing.check`, `billing.may`, `billing.plan`,
`billing.priceList`, `billing.settle`, `billing.spent` and `billing.tier`: its plugins, its
schedules and the system.

## Where it shows

It has no Views of its own: its front ends show it, [`credits-web`](credits-web.md).

- **What it adds to resources:** `planTier` (`action`), `spending` (`check`, `may`), `usage`
  (`priceList`, `spent`).

## What it needs

You set it in `resources.billing`: 8 settings are required.

| Setting            | Type                        | Required | What it is                                                                                                                                                                                                            |
| ------------------ | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.enforce`  | `boolean`                   | yes      | Whether limits apply.                                                                                                                                                                                                 |
| `billing.plans`    | `Record<string, PlanTerms>` | yes      | The plans there are, and the one an org starts on.                                                                                                                                                                    |
| `billing.start`    | `string`                    | yes      | The plans there are, and the one an org starts on.                                                                                                                                                                    |
| `billing.budget`   | `number`                    | no       | The month's limit an org starts with (USD); none: no limit.                                                                                                                                                           |
| `billing.warnAt`   | `number`                    | yes      | The share of a budget or of its credits used when it's said to be running low.                                                                                                                                        |
| `billing.free`     | `string[]`                  | yes      | What's never stopped, by a call's `purpose`: the app's own upkeep, which follows turns.                                                                                                                               |
| `billing.topUps`   | `number[]`                  | yes      | Amounts offered for buying credits (USD), and the least and most.                                                                                                                                                     |
| `billing.topUpMin` | `number`                    | yes      | Amounts offered for buying credits (USD), and the least and most.                                                                                                                                                     |
| `billing.topUpMax` | `number`                    | yes      | Amounts offered for buying credits (USD), and the least and most.                                                                                                                                                     |
| `billing.pay`      | `object`                    | no       | How an org pays, when something lets it (the Actions `stripe` names): checking out, managing what it pays, and which plans can be sold to it now (`sellable`: `{}` → plan names; none: every plan with a seat price). |
| `billing.live`     | `boolean`                   | no       | Real money: what came from a test mode stops counting.                                                                                                                                                                |

It also reads `directory` and `org`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`usage`](usage.md): add it too.

It moves to its own package, `@copilotz/billing`, for `copilotz` `^1.0.0-rc.32`. Until then, it
ships in `copilotz`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `billing.settle` calls `billing.settle`, cron 20 0 * * * (UTC). Writes what's come due: the trial,
  this period's credits, a waiver that ended.

## Listing

It keeps every listing rule.
