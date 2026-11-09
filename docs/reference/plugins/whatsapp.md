---
title: "whatsapp"
description: "WhatsApp: people talk to their agents from WhatsApp, through Meta's Cloud API."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# whatsapp

WhatsApp: people talk to their agents from WhatsApp, through Meta's Cloud API.

```ts
import { whatsapp } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 9 collections, 3 of them on the record.

| Collection         | Kept as                             | Fields                                                                                                                          |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_blocked` | documents                           | `number`, `at`                                                                                                                  |
| `whatsapp_code`    | documents                           | `number`, `code`, `person`, `expires`, `at`                                                                                     |
| `whatsapp_number`  | documents                           | `in`, `phoneId`, `phone`, `name`, `url`, `by`, `problem`, `open`, `agent`, `gap`, `rate`, `quiet`, `language`, `declared`, `at` |
| `whatsapp_phone`   | documents                           | `number`, `phone`, `name`, `person`, `linked`, `space`, `thread`, `contact`, `told`, `tries`, `since`, `at`                     |
| `whatsapp_rate`    | in memory, gone on restart          | `minute`, `count`                                                                                                               |
| `whatsapp_secret`  | documents                           | `token`, `secret`, `verify`; private: `secret`, `token`, `verify`                                                               |
| `whatsapp_sent`    | records, appended and never changed | `message`, `thread`, `key`, `wamid`, `at`                                                                                       |
| `whatsapp_thread`  | documents                           | `number`, `phone`, `person`, `contact`, `at`                                                                                    |
| `whatsapp_typing`  | in memory, gone on restart          | `number`, `wamid`, `at`, `shown`                                                                                                |

The access rules cover `whatsapp_number`: each document is in a space, and only those who reach the
space reach it.

## What it lets callers do

Of its 11 Actions, people may call 9; agents, contacts and someone signed out may call none.

| Action                 | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                      |
| ---------------------- | ------ | ----- | ------- | ------ | --- | ------- | --------------------------------------------------------------------------------- |
| `whatsapp.block`       | yes    | no    | no      | no     | no  | no      | Blocks the phone behind a WhatsApp chat, or lets it in again.                     |
| `whatsapp.connect`     | yes    | no    | no      | no     | no  | no      | Connects a WhatsApp Business number to a space you manage.                        |
| `whatsapp.credentials` | yes    | no    | no      | no     | no  | no      | Replaces a connected WhatsApp number's access token or app secret.                |
| `whatsapp.disconnect`  | yes    | no    | no      | no     | no  | no      | Disconnects a WhatsApp number from its space.                                     |
| `whatsapp.link`        | yes    | no    | no      | no     | no  | no      | A code to send a WhatsApp number from your phone, to link it to you.              |
| `whatsapp.move`        | yes    | no    | no      | no     | no  | no      | Where your messages from WhatsApp go: a space you may write in.                   |
| `whatsapp.set`         | yes    | no    | no      | no     | no  | no      | Opens a WhatsApp number to anyone (a customer line), or closes it.                |
| `whatsapp.unlink`      | yes    | no    | no      | no     | no  | no      | Unlinks your phone from a WhatsApp number.                                        |
| `whatsapp.webhook`     | yes    | no    | no      | no     | no  | no      | Where a WhatsApp number's webhook is, and its verify token, for Meta's dashboard. |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `whatsapp.number` and `whatsapp.receive`: its plugins, its schedules
and the system.

It answers 1 route over HTTP:

| Method    | Path                |
| --------- | ------------------- |
| GET, POST | `/hooks/whatsapp/*` |

It also adds rules every read and write keeps to (`guard`).

## Where it shows

Its Views show elsewhere.

- **Elsewhere:** `whatsapp.message`.
- **Front ends:** [`whatsapp-web`](whatsapp-web.md).

## What it needs

You set it in `resources.whatsapp`: 5 settings are required, and 2 are secrets, kept out of your
code.

| Setting                    | Type           | Required | What it is                                                                                                                                 |
| -------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `whatsapp.<name>.in`       | `string`       | yes      | The space its customers' chats live in: one the app declares too (the spaces plugin's `spaces` resource) is made and kept with the number. |
| `whatsapp.<name>.phoneId`  | `string`       | yes      | Meta's id for the number, its access token, and the Meta app's secret (signing its webhook).                                               |
| `whatsapp.<name>.token`    | `string`       | yes      | Secret. Meta's id for the number, its access token, and the Meta app's secret (signing its webhook).                                       |
| `whatsapp.<name>.secret`   | `string`       | yes      | Secret. Meta's id for the number, its access token, and the Meta app's secret (signing its webhook).                                       |
| `whatsapp.<name>.verify`   | `string`       | yes      | What Meta shows to check its webhook, the app's own.                                                                                       |
| `whatsapp.<name>.path`     | `string`       | no       | Where its webhook is: `/hooks/whatsapp/<name>` unless the app routes another path to the plugin's `hookRoute` (its `routes` field).        |
| `whatsapp.<name>.agent`    | `string`       | no       | Who answers its customers; a quiet chat's hours; messages a minute; seconds a burst may go on before the answer; customers' language.      |
| `whatsapp.<name>.gap`      | `number`       | no       | Who answers its customers; a quiet chat's hours; messages a minute; seconds a burst may go on before the answer; customers' language.      |
| `whatsapp.<name>.rate`     | `number`       | no       | Who answers its customers; a quiet chat's hours; messages a minute; seconds a burst may go on before the answer; customers' language.      |
| `whatsapp.<name>.quiet`    | `number`       | no       | Who answers its customers; a quiet chat's hours; messages a minute; seconds a burst may go on before the answer; customers' language.      |
| `whatsapp.<name>.language` | `"en" \| "pt"` | no       | Who answers its customers; a quiet chat's hours; messages a minute; seconds a burst may go on before the answer; customers' language.      |
| `whatsapp.<name>.phone`    | `string`       | no       | The number as people dial it, and the business's name, as shown.                                                                           |
| `whatsapp.<name>.name`     | `string`       | no       | The number as people dial it, and the business's name, as shown.                                                                           |

It also reads `additions`, `links` and `spaces`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md), [`spaces`](spaces.md) and
[`contacts`](contacts.md): add them too.

It ships with `copilotz@1.0.0-rc.32`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `whatsapp.forget` runs on `contact.deleted`.
- `whatsapp.receive` runs on `whatsapp.received`.
- `whatsapp.reply` runs on `message.created`.
- `whatsapp.typing` runs on `message.created`.
- `whatsapp.undelivered` runs on `whatsapp.undelivered`.
- It emits `whatsapp.received`. Someone sent a connected WhatsApp number a message.
- It emits `whatsapp.undelivered`. A message a connected WhatsApp number sent wasn't delivered.

## Listing

It breaks 1 listing rule as it is:

- Route "/hooks/whatsapp/*" isn't under /whatsapp.
