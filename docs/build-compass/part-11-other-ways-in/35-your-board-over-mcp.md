---
title: "Chapter 35: Your board over MCP"
description: "An assistant on your machine (Claude Code, any MCP client) calls the board's tools, the same ones North uses: Compass's own mcp plugin, with Copilotz's contract, for one person, each call written in a chat of yours."
section: Build Compass
order: 350
status: stable
---

# Chapter 35: Your board over MCP

> Part 11, other ways in · Requires: Chapter 34 · Code: `lesson-11.3`

## The pain

You code with an assistant in your editor or terminal (Claude Code, Codex). It finishes the intro,
and then you switch to Compass to move the card. The assistant could do it, if it could reach the
board.

## The problem

Assistants reach tools over MCP, the Model Context Protocol. Compass's agents already have the
board's tools (Chapter 11); an assistant outside should get those same tools, run the same way,
checked by the same rules, and you should see what it did, not just trust it. And only an assistant
of yours: nobody else, and no web page, may call them.

## The solution

Copilotz has an `mcp` plugin. It **can't run on Compass's plugins**, and the reason is who calls:
it's built for apps whose MCP servers are open to anyone (ChatGPT's users), so each conversation is
a **contact**, a stranger in a chat of its own. It requires Copilotz's `contacts` plugin, and the
`links` resource's secret, which makes the contacts' ids. Its first call makes the contact and its
chat with `space.keep` (a space the app declares), and contacts shares the chat with the contact
through `member.set`. Compass's spaces, for one person, have neither Action. Add `contacts`, a
secret, and the `tool:<name>` View Copilotz's mcp wants for each tool it offers, and on Compass it
answers `initialize` and `tools/list`, then fails its first `tools/call`
(`Unknown action "space.keep"`, an internal error to the caller). Nor should we add them: in
Compass, the caller is you.

So, as with every plugin besides the agentic core, Compass rebuilds it: **`plugins/mcp`, the same
contract, for you.** A server the app declares in the `mcp` resource (its space, the tools it
offers, their hints, its client) is an MCP server at `POST /mcp/<name>`.

### The server, declared

`app.ts`'s settings declare one, `compass`, in your Personal space, with the board's six tools:

```ts
// Your board for an assistant on this machine (Claude Code, Codex): POST /mcp/compass.
mcp: {
  compass: {
    in: `personal:${settings.you.person}`,
    client: "Claude",
    title: "Compass",
    instructions: "Your board in Compass, in your Personal space: read it before you " +
      "change it, and move a card when its state changes.",
    tools: {
      list_boards: { annotations: { readOnly: true } },
      read_board: { annotations: { readOnly: true } },
      create_board: {},
      create_card: {},
      update_card: {},
      move_card: {},
    },
  },
},
```

Only the tools it lists are offered. `annotations` are hints MCP passes on (`readOnlyHint`…), over
the tool's own. `client` is who the steps in its chat are from. And `server.ts` now makes your
Personal space as it starts, so the server's space is there before anything calls in.

### The route

`routes/server.ts` speaks MCP's Streamable HTTP transport, with no session: one JSON-RPC 2.0 message
a request, answered with JSON. First, who may call:

```ts
export const serveMcp: Route = async (request, { runtime, actor }) => {
  const resources = runtime.describe().resources;
  const line = serverOf(resources, new URL(request.url).pathname.slice("/mcp/".length));
  if (!line) return respond(404, fault(undefined, REQUEST, "No MCP server here"));
  if (request.method !== "POST") return respond(405, undefined, { allow: "POST" });
  if (request.headers.get("origin") !== null) {
    return respond(403, fault(undefined, REQUEST, "Not from this origin"));
  }
  if (actor.kind !== "person") {
    return respond(401, fault(undefined, REQUEST, "Only you, from this machine"));
  }
  // … JSON only; bad JSON is -32700, a malformed message -32600, a notification 202
```

A request with an `Origin` comes from a web page, and no page needs to call this, so even the app's
own page is refused (the runtime already refuses a page from another site). The `actor` is
identity's `who`: from this machine, you. Then four methods:

```ts
switch (message.method) {
  case "initialize": {
    // The version the client asked for, if it's one this takes; else the newest.
    const asked = String(params.protocolVersion);
    return ok({
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: serverInfo(line),
      ...(line.instructions ? { instructions: line.instructions } : {}),
    });
  }
  case "ping":
    return ok({});
  case "tools/list":
    return ok({ tools: listed(line, resources) });
  case "tools/call": {
    // … an unknown tool, or arguments that aren't an object: -32602
    const { text, isError } = await runtime.call<{ text: string; isError?: true }>(
      "mcp.call",
      { line: line.name, tool, input, call: `mcp:${line.name}:${String(id).slice(0, 80)}` },
      { actor },
    );
    return ok({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
  }
  default:
    return failed(METHOD, "Method not found");
}
```

`listed` gives each tool its name, title, description, input schema and its hints as MCP names them,
with MCP's defaults where nothing says (a tool that isn't read-only may be destructive).

### The call

The route does HTTP; the work is an Action's. `mcp.call` runs as you:

```ts
// The server's chat, in its space: opening it again changes nothing.
const thread = `mcp-${line.name}`;
await ctx.call("chat.open", { in: line.in, thread, title: line.client.slice(0, 120) });

const step = crypto.randomUUID();
const ran = await runTool(ctx, input.tool, input.input, {
  agent: line.client,
  thread,
  trigger: step,
  callId: step,
  retry: false,
});
const call: Step = { id: input.call, name: input.tool, input: input.input, output: ran.output };
const failed = ran.error !== undefined;
const text = failed
  ? isPublic(ran.error) && ran.error instanceof Error ? ran.error.message : SAID.failed
  : await toolText(ctx, call, { kind: "agent", name: line.client });
// The step, as an agent's is written: a private message from the client, with the call.
await ctx.as().db.collection("message").insertOne({
  _id: step,
  thread,
  in: line.in,
  from: line.client,
  to: [],
  private: true,
  toolCalls: [call],
  at: new Date().toISOString(),
});
```

- **`runTool`** is chat's tool runner, exported for whoever else runs tools: the input checked
  against the tool's schema, then its `run`, as an agent's turn would. The board's tools find their
  space from the thread (`mcp-compass`, in your Personal space) and call the board's Actions as you.
- **`toolText`** is what a model reads of a call: the tool's `tool:<name>` View if it has one, else
  its output. An error says its words only when they're for anyone (`failure(…, { public: true })`);
  anything else is "Something went wrong running that tool. Try again in a moment."
- **The step** is written as an agent's is, so the server's chat, "Claude", shows every call, what
  it was given and what it said.

Left out of Copilotz's, as `mod.ts` says: contacts and their HMAC ids, limits, receipts for calls
sent again, slow calls, the app's front and allowed origins, widgets, MCP 2026-07-28's requests
without a handshake, batches, and a `tool:<name>` View for every tool offered.

## Run it

Start the server (`npm run dev`). Any MCP client speaking Streamable HTTP takes the address; for
Claude Code:

```sh
claude mcp add --transport http compass http://127.0.0.1:8080/mcp/compass
```

By hand, `initialize`, then a call (`tools/list`, between them, is long):

```text
$ curl -s http://127.0.0.1:8080/mcp/compass -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"compass","title":"Compass","version":"1.0.0"},"instructions":"Your board in Compass, in your Personal space: read it before you change it, and move a card when its state changes."}}

$ curl -s http://127.0.0.1:8080/mcp/compass -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"move_card","arguments":{"card":"Publish the page","column":"Doing"}}}'
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Moved “Publish the page” [841089cc5d26] from To do to Doing — on “Launch” (/board/50550b789de3)."}]}}
```

`tools/list` names the six, `list_boards` and `read_board` read-only. `read_board` answers what
North reads:

```text
Board “Launch” (/board/50550b789de3): 6 columns, 3 cards.

## Backlog (0)
(empty)
## To do (0)
(empty)
## Doing (3)
- [d45913fd9143] Write the intro · unassigned
- [c98490c04f24] Record the demo · unassigned
- [841089cc5d26] Publish the page · unassigned
…
```

The Board tab shows the card moved, and a chat called Claude in your Personal space holds each call.
From the app's own page (a request with an `Origin`), it's a 403:

```text
{"jsonrpc":"2.0","error":{"code":-32600,"message":"Not from this origin"}}
```

## Check it

`tests/mcp.test.ts` speaks JSON-RPC through `runtime.fetch` from `127.0.0.1`: `initialize`, the
notification (202), `tools/list` with the six tools and their hints, `move_card` and `read_board`,
and the two steps in the server's chat; a card that isn't there comes back as the tool's words, an
unknown tool as -32602, an unknown method as -32601; another address is a 401, a page a 403, a `GET`
a 405.

`tests/parity.test.ts` runs one conversation on Copilotz's mcp (on Copilotz's identity, spaces and
contacts, where the caller is a contact) and on Compass's (where it's you), with three tools of its
own (one that answers, one that refuses in public, one that fails inside), and compares everything:
`initialize`, `tools/list`, each call's answer, the protocol's errors, and the steps written.

```text
✔ initialize, tools/list and tools/call: the board's tools, as you
✔ a refusal says why; an unknown tool or method is JSON-RPC's error
✔ only you, from this machine: another address, or a page, is refused
✔ Copilotz's mcp and Compass's answer the same conversation the same
```

## Also in this chapter

- `plugins/mcp/contract.ts`: the shape of a server the app declares (`DeclaredServer`, `McpTool`).
- `plugins/mcp/shared/servers.ts`: a server by name, with its defaults, and the tools it offers.
- `plugins/mcp/mod.ts`: the plugin, which requires `chat` and `spaces`; at start, each server must
  say its space and offer only tools the app has.
- `app.ts`: `mcp` in the list, after `webTools`.

`git diff lesson-11.2 lesson-11.3` shows every change.

## What you have now

Compass has five ways in: the browser, the terminal, North, any program on your machine (the REST
API and the client), and any assistant on your machine (MCP), all through the same Actions and
rules, all as you, and nobody else.
