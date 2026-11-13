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

Of its 4 Actions, people, agents, contacts and someone signed out may call none.

| Action       | Person | Agent | Contact | Anyone | Key | What it does                                                                   |
| ------------ | ------ | ----- | ------- | ------ | --- | ------------------------------------------------------------------------------ |
| `mcp.call`   | no     | no    | no      | no     | no  | One call to one of the app's tools, from a model outside (MCP).                |
| `mcp.public` | no     | no    | no      | no     | no  | One call to one of a public server's tools, as the public (MCP): kept nowhere. |

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

| Setting                   | Type                              | Required | What it is                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.<name>.in`           | `string`                          | yes      | The space its conversations' chats live in (declared with the spaces plugin's `spaces`, or not); on a public server, the space its tools work in (`ctx.in`).                                                                             |
| `mcp.<name>.tools`        | `Record<string, McpTool \| null>` | yes      | The tools it offers, by name (the `tools` resource's), each with how it's offered (`{}` as it is).                                                                                                                                       |
| `mcp.<name>.title`        | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                                                                |
| `mcp.<name>.version`      | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                                                                |
| `mcp.<name>.instructions` | `string`                          | no       | What it's called, its version, and what the model is told about using it.                                                                                                                                                                |
| `mcp.<name>.client`       | `string`                          | no       | Who calls (`ChatGPT`), as its chats show it: the sender of their steps, and their title.                                                                                                                                                 |
| `mcp.<name>.handles`      | `boolean`                         | no       | A client that names no conversation (no `openai/session`, which ChatGPT sends) gets a handle to name it with (`chat`, on every tool), so its calls go on in one chat.                                                                    |
| `mcp.<name>.public`       | `boolean`                         | no       | A public server, which keeps nothing: each call runs its tool as the public (`{ kind: "public" }`, whom `publicCallers` lets in), with no contact, chat or step, and only the tools that only read (`annotations.readOnly`) are offered. |
| `mcp.<name>.origins`      | `string[]`                        | no       | The browser origins it answers (`Origin`, or `"*"` for any): none unless said (no browser calls MCP).                                                                                                                                    |
| `mcp.<name>.widgets`      | `McpWidgets`                      | no       | Its widgets (with the app's `widgets` resource, `widgetsOf`): the template's options.                                                                                                                                                    |
| `mcp.<name>.limits`       | `Partial<McpLimits>`              | no       | What it takes before it says no, over the defaults (`MCP_LIMITS`): see `McpLimits`.                                                                                                                                                      |
| `mcp.<name>.exempt`       | `string[]`                        | no       | Callers whose address is in these CIDR ranges (a shared proxy's: OpenAI's egress, every ChatGPT user's calls behind a few addresses) aren't limited by address; the server's other limits still hold.                                    |

It also reads `caller`, `org`, `tools` and `widgets`, resource kinds the app and other plugins fill.

## What it requires

The runtime doesn't start without [`chat`](chat.md), [`spaces`](spaces.md) and
[`contacts`](contacts.md): add them too.

It ships with `copilotz@1.0.0-rc.45`.

## What it does on its own

Some of its work starts without a caller: an event, or the time.

- `mcp.erased` runs on `thread.deleted`.
- `mcp.forgotten` runs on `contact.deleted`.
- `mcp.prune` calls `mcp.prune`, every 10m. Drops MCP's counters, receipts and openings that are
  past.

## Listing

It keeps every listing rule.

## A public server

<!-- Written by hand, not by scripts/describe.ts: keep it when the page is made again. -->

A server with `public: true` is anyone's, and keeps nothing. It's for a public, read-only server,
such as a docs site's. Each call runs its tool as the public, `{ kind: "public", id: "" }`, in the
server's space. Nothing is made for it: no contact, no chat, no step, no receipt, no counter in the
store, and no event of its own.

```ts
resources: {
  links: { origin: "https://docs.example.com", secret: env.LINKS_SECRET },
  caller: { header: "cf-connecting-ip", front: env.FRONT_SECRET },
  spaces: { docs: { name: "Docs" } },
  mcp: {
    docs: {
      in: "docs",
      public: true,
      title: "Example docs",
      tools: { search_docs: {}, read_doc: {} },
      limits: { ipPerMinute: 60, linePerMinute: 600 },
    },
  },
}
```

Then let the public read the spaces its tools read, as viewers, from trusted code (a server's start,
or a person who manages the space):

```ts
await runtime.call("space.keep", { id: "docs" });
await runtime.call("member.set", {
  space: "docs",
  member: { kind: "public", id: "" },
  role: "viewer",
});
```

The public reads only the spaces that have it as a viewer: not what they draw on, and no document
shared on its own. It writes nothing, even from a tool marked read-only. A space can't make it more
than a viewer.

**What it lists.** Of the server's `tools`, only those that only read (`annotations.readOnly`, the
tool's own or the server's), and whose `offer` doesn't say no to the public. The mark only chooses
what's listed: what keeps the public from writing is its reach. No tool takes a `chat` handle, and
no answer ends with one. A tool it doesn't list is unknown when called. Widgets and Actions aren't
offered: a server with them, or with `handles: true`, doesn't start.

**What its tools call.** Each Action a tool calls is asked its `allow` for the public: say
`publicCallers` (or `true`) on those it reads through. Make them unrecorded (`record: false`), or
each call still leaves their events.

**Its limits.** Calls at once on the server and from one address (`atOnce`, `addressAtOnce`: past
them, it's busy), calls a minute from one address (`ipPerMinute`, 60) and on the whole server
(`linePerMinute`, 600: past them, the model is told to wait), and `timeout` (20 seconds: past it,
the call is stopped, and its tool's `ctx.signal` aborts). The counts are in memory of a fixed size
(32 KiB a server), however many addresses call, and start over on restart.

**The caller's address** is read as the app's front says it (the `caller` resource: its header,
believed only with the front's secret or through its proxies' `hops`), so an address claimed in a
header around the front counts for nothing; the server's `exempt` ranges aren't limited by address.
Without `caller`, it's the address the socket saw. Behind a proxy, set `caller`: otherwise every
call comes from the proxy, as one caller.

A server is public or keeps conversations. To offer both, declare two: a public one, and one for
ChatGPT's conversations.

> **Warning: a public tool must not go past the public's reach.** Whatever a tool reads as the
> system (`ctx.as()`), through a grant, or through an Action without an `allow`, it hands to anyone
> who asks. Only a deliberate declassifier should: scoped to what it's for, taking no free-form
> query that could widen it, and returning only what anyone may see.
