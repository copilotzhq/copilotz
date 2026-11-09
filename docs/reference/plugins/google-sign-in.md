---
title: "google-sign-in"
description: "Google sign-in: `google.sign-in` turns a Google ID token into a person and a session (with the identity plugin)."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# google-sign-in

Google sign-in: `google.sign-in` turns a Google ID token into a person and a session (with the
identity plugin).

```ts
import { googleSignIn } from "copilotz/plugins/access";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `google.sign-in`: its plugins, its schedules and the
system. Nobody outside does.

It answers 2 routes over HTTP:

| Method    | Path             |
| --------- | ---------------- |
| GET, HEAD | `/google`        |
| POST      | `/signin/google` |

Other plugins call it through its adapters: `googleKeys` (`google`).

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

You set it in `resources.google`: 1 setting is required.

| Setting           | Type                 | Required | What it is                                                                      |
| ----------------- | -------------------- | -------- | ------------------------------------------------------------------------------- |
| `google.clientId` | `string \| string[]` | yes      | Your OAuth client's id (or several): tokens issued for another app are refused. |

Until it's set, the runtime doesn't start. With nothing set, its check says: "set the google
resource's clientId."

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships with `copilotz@1.0.0-rc.31`.

## Listing

It breaks 2 listing rules as it is:

- Route "/google" isn't under /google-sign-in.
- Route "/signin/google" isn't under /google-sign-in.
