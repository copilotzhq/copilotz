---
title: "mcp"
description: "MCP: models outside the app (ChatGPT, Claude, any MCP client) call the app's tools."
section: "Reference"
order: 3
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# mcp

MCP: models outside the app (ChatGPT, Claude, any MCP client) call the app's tools.

```ts
import { mcp } from "copilotz/plugins/interfaces";
```

## What it keeps

It keeps 4 collections.

| Collection    | Kept as                    | Fields                                 |
| ------------- | -------------------------- | -------------------------------------- |
| `mcp_closed`  | documents                  | `at`                                   |
| `mcp_opening` | documents                  | `at`                                   |
| `mcp_rate`    | in memory, gone on restart | `until`, `count`                       |
| `mcp_receipt` | documents                  | `step`, `at`, `done`, `text`, `failed` |

## What it lets callers do

Of its 3 Actions, people, agents, contacts and someone signed out may call none.

| Action     | Person | Agent | Contact | Anyone | Key | What it does                                                    |
| ---------- | ------ | ----- | ------- | ------ | --- | --------------------------------------------------------------- |
| `mcp.call` | no     | no    | no      | no     | no  | One call to one of the app's tools, from a model outside (MCP). |

An agent works for a person, and calls what both may. A key calls only what its scope names.

Only the app's own code calls `mcp.conversation` and `mcp.prune`: its plugins, its schedules and the
system.

It answers 1 route over HTTP:

| Method | Path     |
| ------ | -------- |
| POST   | `/mcp/*` |

## Where it shows

Its Views show to the model.

- **To the model:** `mcp:offered`.

## What it needs

You set it in `resources.mcp`: 2 settings are required.

| Setting                   | Type                              | Required | What it is                                                                                                                                                                                            |
| ------------------------- | --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.<name>.in`           | `string`                          | yes      | The space its conversations' chats live in (declared with the spaces plugin's `spaces`, or not).                                                                                                      |
| `mcp.<name>.tools`        | `Record<string, McpTool \| null>` | yes      | The tools it offers, by name (the `tools` resource's), each with how it's offered (`{}` as it is).                                                                                                    |
| `mcp.<name>.title`        | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                             |
| `mcp.<name>.version`      | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                             |
| `mcp.<name>.instructions` | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                             |
| `mcp.<name>.client`       | `string`                          | no       | Who calls (`ChatGPT`), as its chats show it: the sender of their steps, and their title.                                                                                                              |
| `mcp.<name>.handles`      | `boolean`                         | no       | A client that names no conversation (no `openai/session`, which ChatGPT sends) gets a handle to name it with (`chat`, on every tool), so its calls go on in one chat.                                 |
| `mcp.<name>.origins`      | `string[]`                        | no       | The browser origins it answers (`Origin`): none unless said (no browser calls MCP).                                                                                                                   |
| `mcp.<name>.widgets`      | `McpWidgets`                      | no       | Its widgets (with the app's `widgets` resource, `widgetsOf`): the template's options.                                                                                                                 |
| `mcp.<name>.limits`       | `Partial<McpLimits>`              | no       | Its widgets (with the app's `widgets` resource, `widgetsOf`): the template's options.                                                                                                                 |
| `mcp.<name>.exempt`       | `string[]`                        | no       | Callers whose address is in these CIDR ranges (a shared proxy's: OpenAI's egress, every ChatGPT user's calls behind a few addresses) aren't limited by address; the server's other limits still hold. |

It also reads `caller`, `org`, `tools` and `widgets`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md), [`spaces`](spaces.md) and
[`contacts`](contacts.md): add them too.

It ships with `copilotz@1.0.0-rc.32`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `mcp.erased` runs on `thread.deleted`.
- `mcp.forgotten` runs on `contact.deleted`.
- `mcp.prune` calls `mcp.prune`, every 10m. Drops MCP's counters, receipts and openings that are
  past.

## Listing

It keeps every listing rule.
