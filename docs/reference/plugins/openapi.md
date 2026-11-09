---
title: "openapi"
description: "OpenAPI: an HTTP API's operations as Actions and as tools for agents, made from its OpenAPI 3 spec."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# openapi

OpenAPI: an HTTP API's operations as Actions and as tools for agents, made from its OpenAPI 3 spec.

Its Actions and tools come from your API's spec. This page describes
`openapi({ name: "trips", spec })` for a spec with 2 operations, `listTrips` and `getTrip`.

```ts
import { openapi } from "copilotz/plugins/agents";
```

## What it keeps

It keeps nothing of its own.

## What it lets callers do

Only the app's own code calls its 2 Actions, `trips.getTrip` and `trips.listTrips`: its plugins, its
schedules and the system. Nobody outside does.

Agents act through its 2 tools, as whoever they work for:

| Tool              | What it does                         | Calls |
| ----------------- | ------------------------------------ | ----- |
| `trips_getTrip`   | Reads a trip.                        |       |
| `trips_listTrips` | Lists the trips that match a search. |       |

## Where it shows

It shows to the model through its tools.

- **Agents' tools:** `trips_getTrip`, `trips_listTrips`.

## What it needs

You set it in `resources.openapi`.

| Setting                       | Type                                       | Required | What it is                                                                                                                         |
| ----------------------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.<name>.baseUrl`      | `string`                                   | no       | Where the API is; the spec's `servers[0].url` when not said.                                                                       |
| `openapi.<name>.headers`      | `Record<string, string> \| OpenApiHeaders` | no       | Sent with every call, after the operation's own: static values, or a hook.                                                         |
| `openapi.<name>.query`        | `Record<string, string>`                   | no       | Query parameters sent with every call (a key some APIs take in the URL).                                                           |
| `openapi.<name>.timeout`      | `number`                                   | no       | How long a call may take, in ms (30 s).                                                                                            |
| `openapi.<name>.maxBytes`     | `number`                                   | no       | The most a response may be, in bytes (100 KB), so a huge one can't flood an agent's prompt; a larger one fails.                    |
| `openapi.<name>.files`        | `Record<string, string[]>`                 | no       | By operation id, response fields that hold a file as a data URL or base64 (`["image"]`, `["data.*.b64_json"]`: `*` is every item). |
| `openapi.<name>.maxFileBytes` | `number`                                   | no       | The most a file may be, decoded, and all of one response's together (10 MB).                                                       |
| `openapi.<name>.fileTypes`    | `string[]`                                 | no       | Media types a file may have (`image/*` matches every image); see `FILE_TYPES`.                                                     |

## What it requires

The runtime doesn't start without [`chat`](chat.md): add it too.

It ships with `copilotz@1.0.0-rc.34`.

## Listing

It keeps every listing rule.
