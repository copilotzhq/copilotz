---
title: "maintenance"
description: "Maintenance: HTTP endpoints for an app's operators, for when they can't reach its database themselves (a client's network that keeps their database user out)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# maintenance

Maintenance: HTTP endpoints for an app's operators, for when they can't reach its database
themselves (a client's network that keeps their database user out).

```ts
import { maintenance } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Of its 2 Actions, people, agents, contacts and someone signed out may call none.

| Action              | Person | Agent | Contact | Anyone | Key | Maintenance | What it does                                                                  |
| ------------------- | ------ | ----- | ------- | ------ | --- | ----------- | ----------------------------------------------------------------------------- |
| `maintenance.read`  | no     | no    | no      | no     | no  | yes         | One collection read (find…aggregate) or named query, for the app's operators. |
| `maintenance.write` | no     | no    | no      | no     | no  | yes         | One collection operation (insertOne…deleteMany), for the app's operators.     |

An agent works for a person, and calls what both may. A key calls only what its scope names.

It answers 1 route over HTTP:

| Method | Path             |
| ------ | ---------------- |
| ANY    | `/maintenance/*` |

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.maintenance`, and 1 is a secret, kept out of your code.

| Setting               | Type       | Required | What it is                                                                                                                                                                                           |
| --------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance.key`     | `string`   | no       | Secret. The secret requests show (`Authorization: Bearer <key>`): at least 32 random characters, from the app's environment.                                                                         |
| `maintenance.keys`    | `string[]` | no       | More keys, any of which works: for rotating one (add the new, then remove the old).                                                                                                                  |
| `maintenance.limit`   | `number`   | no       | The most rows (or documents) a read answers with (default 1,000).                                                                                                                                    |
| `maintenance.timeout` | `number`   | no       | The longest a SQL statement may run, in ms (default 30,000).                                                                                                                                         |
| `maintenance.bytes`   | `number`   | no       | The most bytes an answer's rows take (default 8 MB): past it they're cut, and `truncated`.                                                                                                           |
| `maintenance.log`     | `function` | no       | Where a line for each request goes before it runs, so the record of it is also outside the database its holder can write (default: a JSON line on standard output, which hosts like Cloud Run keep). |

It also reads `org`, resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.32`.

## Listing

It keeps every listing rule.
