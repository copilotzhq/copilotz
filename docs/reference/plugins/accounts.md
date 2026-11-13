---
title: "accounts"
description: "Connected accounts: a person connects an outside account once, and agents working for them use it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# accounts

Connected accounts: a person connects an outside account once, and agents working for them use it.

```ts
import { accounts } from "copilotz/plugins/access";
```

## What it keeps

It keeps 3 collections, 1 of them on the record.

| Collection    | Kept as                    | Fields                                                                                                                    |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `account`     | documents                  | `person`, `provider`, `status`, `label`, `plan`, `problem`, `connected`, `refreshed`, `expires`, `rev`; private: `tokens` |
| `accountFlow` | in memory, gone on restart | `person`, `provider`, `verifier`, `redirect`, `expires`                                                                   |
| `modelKey`    | documents                  | `hint`, `by`, `at`; private: `sealed`                                                                                     |

Its named queries read for callers, as the rules let them:

| Query               | Who outside runs it                            |
| ------------------- | ---------------------------------------------- |
| `account.providers` | people, agents for a person, keys and routines |
| `account.uses`      | people, agents for a person, keys and routines |

## What it lets callers do

Of its 11 Actions, people may call 7; agents may call 1; contacts and someone signed out may call
none.

| Action               | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                |
| -------------------- | ------ | ----- | ------- | ------ | --- | ------- | --------------------------------------------------------------------------- |
| `account.callback`   | yes    | no    | no      | no     | no  | no      | Finishes connecting an account, once its provider sent the person back.     |
| `account.complete`   | yes    | no    | no      | no     | no  | no      | Finishes connecting an account from the address its sign-in ended at.       |
| `account.connect`    | yes    | no    | no      | no     | no  | no      | Starts connecting one of your accounts: where to sign in.                   |
| `account.disconnect` | yes    | no    | no      | no     | no  | no      | Disconnects one of your accounts, and asks its provider to end its sign-in. |
| `modelKey.may`       | yes    | yes   | no      | no     | yes | yes     | Whether you may change the org's keys for model providers.                  |
| `modelKey.remove`    | yes    | no    | no      | no     | no  | no      | Removes the org's own key for a model provider.                             |
| `modelKey.set`       | yes    | no    | no      | no     | no  | no      | Adds or replaces the org's own key for a model provider.                    |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `account.refresh`, `account.token`, `modelKey.list` and
`modelKey.open`: its plugins, its schedules and the system.

It answers 1 route over HTTP:

| Method | Path                           |
| ------ | ------------------------------ |
| GET    | `/accounts/callback/:provider` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views of its own: its front ends show it, [`accounts-web`](accounts-web.md).

- **What it adds to resources:** `accountProviders` (`chatgpt`), `cost` (`chatgpt/*`), `modelKeys`
  (`list`, `may`, `open`), `provider` (`chatgpt`).

## What it needs

You set it in `resources.accounts`, and 1 is a secret, kept out of your code.

| Setting        | Type     | Required | What it is |
| -------------- | -------- | -------- | ---------- |
| `accounts.key` | `string` | no       | Secret.    |
| `accounts.url` | `string` | no       |            |

It also reads `accountProviders`, `model` and `org`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.47`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- It emits `account.changed`. An account was connected, lost or disconnected.

## Listing

It keeps every listing rule.
