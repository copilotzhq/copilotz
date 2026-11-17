---
title: "password-sign-in"
description: "Password sign-in: people sign in by an identifier (a username, a badge number, a CPF) and a password, with the identity plugin."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# password-sign-in

Password sign-in: people sign in by an identifier (a username, a badge number, a CPF) and a
password, with the identity plugin.

```ts
import { passwordSignIn } from "copilotz/plugins/access";
```

## What it keeps

It keeps 2 collections, 1 of them on the record.

| Collection       | Kept as                    | Fields                                             |
| ---------------- | -------------------------- | -------------------------------------------------- |
| `password_login` | documents                  | `person`, `hash`, `changed`, `at`; private: `hash` |
| `password_rate`  | in memory, gone on restart | `count`, `until`                                   |

## What it lets callers do

Of its 6 Actions, people may call 1; agents, contacts and someone signed out may call none.

| Action            | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                           |
| ----------------- | ------ | ----- | ------- | ------ | --- | ------- | ---------------------------------------------------------------------- |
| `password.change` | yes    | no    | no      | no     | no  | no      | Changes your password, with the one you have: your other sessions end. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `password.import`, `password.prune`, `password.remove`, `password.set`
and `password.sign-in`: its plugins, its schedules and the system.

It answers 2 routes over HTTP:

| Method    | Path                      |
| --------- | ------------------------- |
| GET, HEAD | `/signin/password`        |
| POST      | `/signin/password/change` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.passwordSignIn`.

| Setting                 | Type     | Required | What it is                                                                                                                                                                                   |
| ----------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passwordSignIn.ignore` | `string` | no       | Characters an identifier is read without, wherever it's typed or set: `".-/"` for a CPF typed with its dots.                                                                                 |
| `passwordSignIn.limits` | `object` | no       | How much one identifier, and one caller, may try (`too_many` past it): tries at an identifier's password in 15 minutes (`tries`, 10), and all one caller asks in 15 minutes (`address`, 30). |

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships with `copilotz@1.0.0-rc.52`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `password.prune` calls `password.prune`, every 10m. Drops password sign-in's counters that are
  past.

## Listing

It breaks 2 listing rules as it is:

- Route "/signin/password" isn't under /password-sign-in.
- Route "/signin/password/change" isn't under /password-sign-in.
