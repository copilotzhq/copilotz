---
title: "email-sign-in"
description: "Email: sending it, and signing in with it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# email-sign-in

Email: sending it, and signing in with it.

```ts
import { emailSignIn } from "copilotz/plugins/access";
```

## What it keeps

It keeps 3 collections, 1 of them on the record.

| Collection    | Kept as                    | Fields                                                                                                       |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `email_code`  | documents                  | `email`, `purpose`, `hash`, `pending`, `name`, `tries`, `expires`, `until`, `at`; private: `hash`, `pending` |
| `email_login` | documents                  | `person`, `verified`, `hash`, `changed`, `at`; private: `hash`                                               |
| `email_rate`  | in memory, gone on restart | `count`, `until`                                                                                             |

## What it lets callers do

Only the app's own code calls its 10 Actions, `email.accept`, `email.forgot`, `email.import`,
`email.invitation`, `email.invite`, `email.prune`, `email.reset`, `email.sign-in`, `email.sign-up`
and `email.verify`: its plugins, its schedules and the system. Nobody outside does.

It answers 7 routes over HTTP:

| Method    | Path                       |
| --------- | -------------------------- |
| GET, HEAD | `/signin/email`            |
| POST      | `/signin/email/accept`     |
| POST      | `/signin/email/forgot`     |
| POST      | `/signin/email/invitation` |
| POST      | `/signin/email/reset`      |
| POST      | `/signin/email/sign-up`    |
| POST      | `/signin/email/verify`     |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.emailSignIn` and `resources.links`: 2 settings are required.

| Setting                | Type      | Required | What it is                                                                                                                                                                                                                                                                            |
| ---------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emailSignIn.signUp`   | `boolean` | no       | Whether people make an account themselves (`POST /signin/email/sign-up`); else only an invitation makes one (`email.invite`).                                                                                                                                                         |
| `emailSignIn.app`      | `string`  | no       | What messages call the app (`{app}`): the host of the `links` origin unless said.                                                                                                                                                                                                     |
| `emailSignIn.messages` | `object`  | yes      | The messages, by what they're for: a sign-up's code (`verify`), a new password's (`reset`), an invitation's link (`invite`), and a sign-up for an address that has an account already (`exists`).                                                                                     |
| `emailSignIn.limits`   | `object`  | no       | How much one address, and one caller, may ask (`too_many` past it): messages to an address an hour (`sends`, 5); tries at a password, a code or a link for an address in 15 minutes (`tries`, 10); and everything one caller (by network address) asks in 15 minutes (`address`, 30). |
| `links`                |           | yes      | emailSignIn needs the links resource ({ origin, secret }): its links go to the origin, and its codes are kept sealed with the secret.                                                                                                                                                 |

Until it's set, the runtime doesn't start. With nothing set, its check says: "emailSignIn needs the
links resource ({ origin, secret }): its links go to the origin, and its codes are kept sealed with
the secret."

## What it requires

The runtime doesn't start without [`identity`](identity.md) and [`email`](email.md): add them too.

It ships with `copilotz@1.0.0-rc.45`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `email.prune` calls `email.prune`, every 10m. Drops email sign-in's codes, links and counters that
  are past.

## Listing

It breaks 7 listing rules as it is:

- Route "/signin/email" isn't under /email-sign-in.
- Route "/signin/email/accept" isn't under /email-sign-in.
- Route "/signin/email/forgot" isn't under /email-sign-in.
- Route "/signin/email/invitation" isn't under /email-sign-in.
- Route "/signin/email/reset" isn't under /email-sign-in.
- Route "/signin/email/sign-up" isn't under /email-sign-in.
- Route "/signin/email/verify" isn't under /email-sign-in.
