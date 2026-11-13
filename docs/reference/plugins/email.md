---
title: "email"
description: "Email: sending it, and signing in with it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# email

Email: sending it, and signing in with it.

```ts
import { email } from "copilotz/plugins/access";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `email.send`: its plugins, its schedules and the system.
Nobody outside does.

Other plugins call it through its adapters: `email` (`console`, `resend`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.email`: 1 setting is required, and 1 is a secret, kept out of your code.

| Setting         | Type     | Required | What it is                                                                                                                                                                                    |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email.adapter` | `string` | yes      | Which adapter sends: `resend` (Resend's API), or `console` on a laptop, which writes each message to the log (refused where the app's `links` origin is public: a code in a log is a way in). |
| `email.from`    | `string` | no       | Who messages are from: `"Example <noreply@example.com>"`.                                                                                                                                     |
| `email.replyTo` | `string` | no       | Where replies go, when not to `from`.                                                                                                                                                         |
| `email.apiKey`  | `string` | no       | Secret. The adapter's key (Resend's).                                                                                                                                                         |

Until it's set, the runtime doesn't start. With nothing set, its check says: "set the email
resource's adapter: resend or console (console on a laptop)."

It also reads `links`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.47`.

## Listing

It keeps every listing rule.
