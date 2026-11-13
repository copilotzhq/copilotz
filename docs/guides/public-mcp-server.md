---
title: "A public MCP server: docs and data for anyone"
description: "A read-only MCP server anyone can call, that keeps nothing: what runs as the public, what it may read, what it lists, its limits, and the one rule for its tools."
section: Guides
order: 6
---

# A public MCP server: docs and data for anyone

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

See also the [`mcp` reference](../reference/plugins/mcp.md), and [Memory](../operations/memory.md)
for running one in a small container.
