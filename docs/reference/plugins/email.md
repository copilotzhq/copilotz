---
title: "email"
description: "Email: sending it, and signing in with it."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# email

Email: sending it, and signing in with it.

## Mail in tests: the capture adapter

Send invoices and receipts with `ctx.call("email.send", { to, subject, text, html, attachments })`.
For tests, import `captureEmail` from `copilotz/plugins/access/email`. Register the mailbox as an
adapter and select it with the email resource:

```ts
const inbox = captureEmail();
const mail = {
  name: "test-mail",
  adapters: { email: { capture: inbox } },
  resources: { email: { adapter: "capture", from: "billing@example.com" } },
};
```

Run the app with `[email, mail]`, then read `inbox.messages` or empty it with `inbox.clear()`. For
MIME source, import `mime` from the same entry point and call `mime(message, from).source`. Capture
never sends, so an app whose `links` origin is public refuses to start with it, unless a test sets
`email.capture.allowPublicOrigin: true`.
[A complete test and .eml files on disk](../../build-compass/part-10-testing/31-fakes-at-the-edges.md#mail-in-tests-the-capture-adapter).

```ts
import { email } from "copilotz/plugins/access";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `email.send`: its plugins, its schedules and the system.
Nobody outside does.

Other plugins call it through its adapters: `email` (`capture`, `console`, `resend`, `sendmail`,
`smtp`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.email`: 1 setting is required, and 1 is a secret, kept out of your code.

| Setting          | Type               | Required | What it is                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `email.adapter`  | `string`           | yes      | Which adapter sends: `capture` (keeps messages for tests), `resend` (Resend's API), `smtp` (a mail server, on Node, Deno and Bun), `sendmail` (a sendmail program, on Node, Deno and Bun), or `console` on a laptop, which writes each message to the log (refused where the app's `links` origin is public: a code in a log is a way in). |
| `email.capture`  | `object`           | no       | Set `directory` to save captured messages as .eml files and `allowPublicOrigin: true` to capture mail in a test with a public `links.origin`.                                                                                                                                                                                              |
| `email.from`     | `string`           | no       | Who messages are from: `"Example <noreply@example.com>"`.                                                                                                                                                                                                                                                                                  |
| `email.senders`  | `string[]`         | no       | Who else a message may be from (its own `from`): addresses (`billing@example.com`), or every address at a domain (`@example.com`).                                                                                                                                                                                                         |
| `email.replyTo`  | `string`           | no       | Where replies go, when not to `from`.                                                                                                                                                                                                                                                                                                      |
| `email.apiKey`   | `string`           | no       | Secret. The adapter's key (Resend's).                                                                                                                                                                                                                                                                                                      |
| `email.smtp`     | `SmtpSettings`     | no       | The `smtp` adapter's server: `{ host, port?, secure?, starttls?, user?, password?, ca?, name?, timeout? }` (see `SmtpSettings`).                                                                                                                                                                                                           |
| `email.sendmail` | `SendmailSettings` | no       | The `sendmail` adapter's program (see `SendmailSettings`).                                                                                                                                                                                                                                                                                 |

Until it's set, the runtime doesn't start. With nothing set, its check says: "set the email
resource's adapter: resend or smtp or sendmail or console or capture (console on a laptop)."

It also reads `links`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.65`.

## Listing

It keeps every listing rule.
