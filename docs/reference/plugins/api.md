---
title: "api"
description: "Developer keys: what code calls the app with, as someone, over the runtime's REST API (`/api/`) or its socket (see runtime/api.ts and runtime/client.ts): `Authorization: Bearer <key>`."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# api

Developer keys: what code calls the app with, as someone, over the runtime's REST API (`/api/`) or
its socket (see runtime/api.ts and runtime/client.ts): `Authorization: Bearer <key>`.

```ts
import { api } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 1 collection, on the record: every change to it is an event.

| Collection | Kept as   | Fields                                                                                 |
| ---------- | --------- | -------------------------------------------------------------------------------------- |
| `api_key`  | documents | `hash`, `person`, `in`, `name`, `hint`, `role`, `scope`, `used`, `at`; private: `hash` |

The access rules cover `api_key`: each document is in a space, and only those who reach the space
reach it.

Its named queries read for callers, as the rules let them:

| Query           | Who outside runs it |
| --------------- | ------------------- |
| `api_key.actor` | the app's code      |
| `api_key.mine`  | people              |

## What it lets callers do

Of its 3 Actions, people may call 2; agents, contacts and someone signed out may call none.

| Action           | Person | Agent | Contact | Anyone | Key | Routine | What it does                                                                   |
| ---------------- | ------ | ----- | ------- | ------ | --- | ------- | ------------------------------------------------------------------------------ |
| `api_key.create` | yes    | no    | no      | no     | no  | no      | Makes a developer key that acts as you in one space; its secret is shown once. |
| `api_key.revoke` | yes    | no    | no      | no     | no  | no      | Revokes a developer key: one of yours, or one in a space you manage.           |

An agent works for a person, and calls what both may. A key calls only what its scope names. A
routine is work done for a person, which they set going.

Only the app's own code calls `api_key.used`: its plugins, its schedules and the system.

It also says who a request is (`who`) and adds rules every read and write keeps to (`guard`).

## Where it shows

It has no Views of its own: its front ends show it, [`api-web`](api-web.md).

## What it needs

Nothing to set: it works as it comes.

## What it requires

The runtime doesn't start without [`spaces`](spaces.md): add it too.

It ships with `copilotz@1.0.0-rc.32`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `api.left` runs on `member.deleted`.

## Listing

It keeps every listing rule.
