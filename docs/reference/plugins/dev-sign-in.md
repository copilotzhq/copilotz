---
title: "dev-sign-in"
description: "Dev sign-in: people sign in by the name they type, from this machine only, for trying an app out (with the identity plugin)."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# dev-sign-in

Dev sign-in: people sign in by the name they type, from this machine only, for trying an app out
(with the identity plugin).

```ts
import { devSignIn } from "copilotz/plugins/access";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 1 Action, `dev.sign-in`: its plugins, its schedules and the
system. Nobody outside does.

It answers 1 route over HTTP:

| Method    | Path          |
| --------- | ------------- |
| GET, POST | `/signin/dev` |

## Where it shows

It has no Views: it shows nowhere on its own.

## What it needs

Nothing to set. It reads `links`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`identity`](identity.md): add it too.

It ships with `copilotz@1.0.0-rc.34`.

## Listing

It breaks 1 listing rule as it is:

- Route "/signin/dev" isn't under /dev-sign-in.
