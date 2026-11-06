/**
 * The protocol: MCP's Streamable HTTP, JSON-RPC 2.0, without a session.
 * The handshake of the versions that have one, discovery without it, the
 * right errors with the right HTTP status, the headers 2026-07-28 repeats
 * and checks, batches only where MCP had them, and the HTTP limits.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createRuntime, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { mcp } from "../mod.ts";
import type { DeclaredServer } from "../shared/settings.ts";
import { app, LINE, MODERN, OFFERED, runs, said, type Setup, setup } from "./setup.ts";

test("initialize: the version asked for when taken, else the newest with a handshake; no session", async () => {
  await setup(async (s) => {
    const first = await s.post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openai-mcp", version: "1.0.0" },
      },
    });
    assertEquals(first.status, 200);
    assertEquals(first.headers.get("mcp-session-id"), null);
    assertEquals(first.headers.get("content-type"), "application/json");
    assertEquals(first.body.result, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "chatgpt", title: "Viação Azul", version: "1.0.0" },
      instructions: "Buy bus tickets.",
    });
    const later = await s.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2099-01-01",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
    });
    assertEquals(later.body.result?.protocolVersion, "2025-11-25");
    // The handshake's end, and any other notification: accepted, nothing said.
    const done = await s.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { headers: { "mcp-protocol-version": "2025-06-18" } },
    );
    assertEquals([done.status, done.text], [202, ""]);
    const ping = await s.legacy("ping");
    assertEquals(ping.body.result, {});
  });
});

test("server/discover, modern: versions, tools, who it is, and every result says it's complete", async () => {
  await setup(async (s) => {
    const found = await s.modern("server/discover");
    assertEquals(found.status, 200);
    const result = found.body.result!;
    assertEquals(result.resultType, "complete");
    assertEquals(result.supportedVersions, [MODERN, "2025-11-25", "2025-06-18", "2025-03-26"]);
    assertEquals(result.capabilities, { tools: {} });
    assertEquals(result.instructions, "Buy bus tickets.");
    assertEquals(result.cacheScope, "public");
    assertEquals((result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"], {
      name: "chatgpt",
      title: "Viação Azul",
      version: "1.0.0",
    });
    const listed = await s.modern("tools/list");
    assertEquals(listed.body.result?.resultType, "complete");
    assert(typeof listed.body.result?.ttlMs === "number");
  });
});

test("HTTP: POST only (405 for GET and DELETE), JSON only, within the body limit, at a line", async () => {
  await setup(async (s) => {
    for (const method of ["GET", "DELETE"]) {
      const answer = await s.post(undefined, { method });
      assertEquals(answer.status, 405);
      assertEquals(answer.headers.get("allow"), "POST");
    }
    const form = await s.post("a=1", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assertEquals(form.status, 415);
    const large = await s.legacy("tools/call", {
      name: "search",
      arguments: { to: "x".repeat(70_000) },
    });
    assertEquals(large.status, 413);
    const nowhere = await s.legacy("ping", undefined, { line: "nope" });
    assertEquals(nowhere.status, 404);
  }, { line: { limits: { body: 65_536 } } });
});

test("Origin: a browser's page only from an origin the line names; none, unless it says", async () => {
  const ping = (s: Setup, origin: string) =>
    s.post({ jsonrpc: "2.0", id: 1, method: "ping" }, {
      headers: { "mcp-protocol-version": "2025-11-25", origin },
    });
  await setup(async (s) => {
    // The runtime's cross-site rule refuses an Origin that isn't the site's own, before the
    // route: so the origin a line names that can reach it is the site's own (here, localhost).
    assertEquals((await ping(s, "http://localhost")).status, 200);
    const other = await ping(s, "https://evil.example");
    assertEquals([other.status, other.body.id], [403, undefined]);
  }, { line: { origins: ["http://localhost"] } });
  await setup(async (s) => {
    for (
      const origin of [
        "https://somewhere.example",
        "null",
        "https://chatgpt.com",
        "http://localhost",
      ]
    ) {
      assertEquals((await ping(s, origin)).status, 403);
    }
    // No Origin, as servers (ChatGPT's) call: taken.
    assertEquals((await s.legacy("ping")).status, 200);
  });
});

test("JSON-RPC errors: bad JSON, not JSON-RPC, bad ids, unknown methods and versions", async () => {
  await setup(async (s) => {
    const garbage = await s.post("{nope", { headers: { "mcp-protocol-version": "2025-11-25" } });
    assertEquals([garbage.status, garbage.body.error?.code], [400, -32700]);
    const loose = await s.post({ id: 1, method: "ping" }, {
      headers: { "mcp-protocol-version": "2025-11-25" },
    });
    assertEquals([loose.status, loose.body.error?.code], [400, -32600]);
    const nullId = await s.legacy("ping", undefined, { id: null });
    assertEquals([nullId.status, nullId.body.error?.code], [400, -32600]);
    const floatId = await s.legacy("ping", undefined, { id: 1.5 });
    assertEquals(floatId.body.error?.code, -32600);
    // Legacy: an error in the body; modern: a 404, as MCP 2026-07-28 says.
    const unknown = await s.legacy("resources/list", undefined, { id: "r1" });
    assertEquals([unknown.status, unknown.body.id, unknown.body.error?.code], [200, "r1", -32601]);
    const unknownModern = await s.modern("resources/list");
    assertEquals([unknownModern.status, unknownModern.body.error?.code], [404, -32601]);
    const old = await s.post({ jsonrpc: "2.0", id: 9, method: "ping" }, {
      headers: { "mcp-protocol-version": "2024-11-05" },
    });
    assertEquals([old.status, old.body.id, old.body.error?.code], [400, 9, -32022]);
    assertEquals((old.body.error?.data as { supported: string[] }).supported[0], MODERN);
    // Tools that aren't the line's: an error, not a call.
    const missing = await s.legacy("tools/call", { name: "send_message", arguments: {} });
    assertEquals(missing.body.error?.code, -32602);
    assertMatch(missing.body.error?.message ?? "", /Unknown tool: send_message/);
    const badArgs = await s.legacy("tools/call", { name: "search", arguments: [1] });
    assertEquals(badArgs.body.error?.code, -32602);
    const cursor = await s.legacy("tools/list", { cursor: "x" });
    assertEquals(cursor.body.error?.code, -32602);
  });
});

test("modern requests: _meta and headers must say the same as the body (-32020, -32602)", async () => {
  await setup(async (s) => {
    const ok = await s.modern("tools/call", { name: "search", arguments: { to: "Rio" } });
    assertEquals(ok.status, 200);
    assertEquals(ok.body.result?.resultType, "complete");
    const noMethod = await s.modern("tools/list", {}, { headers: { "mcp-method": "tools/call" } });
    assertEquals([noMethod.status, noMethod.body.error?.code], [400, -32020]);
    const otherName = await s.modern("tools/call", { name: "search", arguments: { to: "Rio" } }, {
      headers: { "mcp-name": "pick" },
    });
    assertEquals([otherName.status, otherName.body.error?.code], [400, -32020]);
    // A name in MCP's base64 form is decoded before it's compared.
    const encoded = await s.modern("tools/call", { name: "search", arguments: { to: "Rio" } }, {
      headers: { "mcp-name": `=?base64?${btoa("search")}?=` },
    });
    assertEquals(encoded.status, 200);
    const unheaded = await s.post({
      jsonrpc: "2.0",
      id: 5,
      method: "ping",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    assertEquals([unheaded.status, unheaded.body.error?.code], [400, -32020]);
    const bare = await s.post({ jsonrpc: "2.0", id: 6, method: "ping", params: {} }, {
      headers: { "mcp-protocol-version": MODERN, "mcp-method": "ping" },
    });
    assertEquals([bare.status, bare.body.error?.code], [400, -32602]);
    const crossed = await s.post({
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }, { headers: { "mcp-protocol-version": "2025-11-25" } });
    assertEquals([crossed.status, crossed.body.error?.code], [400, -32020]);
  });
});

test("a tool's mirrored input (x-mcp-header) must be in its header, as sent", async () => {
  const region = definePlugin({
    name: "region",
    resources: {
      tools: {
        zone: {
          description: "Says the zone",
          input: {
            type: "object",
            properties: { zone: { type: "string", "x-mcp-header": "Zone" } },
          },
          run: (input: { zone?: string }) => `zone ${input.zone}`,
        },
      },
    },
    views: { "tool:zone": (call: { output: string }) => call.output },
  });
  await setup(async (s) => {
    const missing = await s.modern("tools/call", { name: "zone", arguments: { zone: "sp" } });
    assertEquals([missing.status, missing.body.error?.code], [400, -32020]);
    const given = await s.modern("tools/call", { name: "zone", arguments: { zone: "sp" } }, {
      headers: { "mcp-param-zone": "sp" },
    });
    assertEquals(given.status, 200);
    const none = await s.modern("tools/call", { name: "zone", arguments: {} });
    assertEquals(none.status, 200);
  }, { line: { tools: { zone: {} } }, plugins: [region] });
});

test("batches: only from a 2025-03-26 client, 10 messages at most, answered one by one", async () => {
  await setup(async (s) => {
    const batch = await s.post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "slow", arguments: {}, _meta: { "openai/session": "b1" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "slow", arguments: {}, _meta: { "openai/session": "b2" } },
      },
    ], { headers: { "mcp-protocol-version": "" } });
    assertEquals(batch.status, 200);
    const answers = batch.body as unknown as { id: number }[];
    assertEquals(answers.map((a) => a.id), [1, 2, 3, 4]);
    assertEquals(runs.slow, 2);
    const notes = await s.post([{ jsonrpc: "2.0", method: "notifications/initialized" }], {
      headers: { "mcp-protocol-version": "" },
    });
    assertEquals(notes.status, 202);
    const long = await s.post(
      Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })),
      { headers: { "mcp-protocol-version": "" } },
    );
    assertEquals([long.status, long.body.error?.code], [400, -32600]);
    const refused = await s.post([{ jsonrpc: "2.0", id: 1, method: "ping" }], {
      headers: { "mcp-protocol-version": "2025-11-25" },
    });
    assertEquals([refused.status, refused.body.error?.code], [400, -32600]);
  });
});

test("tools/list: the line's tools in order, titled, with every hint, status lines, no sign-in", async () => {
  await setup(async (s) => {
    const { tools } = (await s.legacy("tools/list")).body.result as {
      tools: Record<string, unknown>[];
    };
    // Not `staff` (its offer says no to contacts), nor `raw` (no View).
    assertEquals(tools.map((t) => t.name), OFFERED);
    const [search, pick] = tools;
    assertEquals(search.title, "Search trips");
    assertEquals(search.description, "Finds trips to a city");
    assertEquals(search.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    assertEquals(search.securitySchemes, [{ type: "noauth" }]);
    assertEquals(search._meta, {
      "openai/toolInvocation/invoking": "Searching…",
      "openai/toolInvocation/invoked": "Found trips.",
      securitySchemes: [{ type: "noauth" }],
    });
    // MCP's defaults where the app says nothing: it may change things, outside too.
    assertEquals(pick.title, "Pick a trip");
    assertEquals(pick.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assertEquals(tools.find((t) => t.name === "slow")!.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // The handle: on every tool's input, optional, past the tool's own fields.
    const input = search.inputSchema as { properties: Record<string, unknown>; required: string[] };
    assertEquals(Object.keys(input.properties), ["to", "chat"]);
    assertEquals(input.required, ["to"]);
  });
});

test("tools/list: a line's own hints over the tool's; no handle when the line gives none", async () => {
  await setup(async (s) => {
    const { tools } = (await s.legacy("tools/list")).body.result as {
      tools: {
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
        annotations: unknown;
      }[];
    };
    assertEquals(tools.map((t) => t.name), ["search", "pick"]);
    assertEquals(Object.keys(tools[0].inputSchema.properties!), ["to"]);
    assertEquals((tools[1].annotations as { idempotentHint: boolean }).idempotentHint, true);
  }, {
    line: { handles: false, tools: { search: {}, pick: { annotations: { idempotent: true } } } },
  });
});

test("an offer that throws: that tool isn't offered, the others are", async () => {
  const shaky = definePlugin({
    name: "shaky",
    views: { "tool:shaky": (call: { output: string }) => call.output },
    resources: {
      tools: {
        shaky: {
          description: "Offered where the chat has a title",
          offer: (_agent: string, thread: { title?: string }) => thread.title!.length > 0,
          run: () => "ok",
        },
      },
    },
  });
  await setup(async (s) => {
    const listed = (await s.legacy("tools/list")).body.result as { tools: { name: string }[] };
    assertEquals(listed.tools.map((t) => t.name), OFFERED);
    const called = await s.call("shaky", {}, { session: "s" });
    assertEquals(said(called), "That tool isn't offered here.");
  }, { line: { tools: { ...LINE.tools, shaky: {} } }, plugins: [shaky] });
});

test("a tool without its View, or whose offer says no, is neither listed nor run", async () => {
  await setup(async (s) => {
    for (const name of ["raw", "staff"]) {
      const listed = (await s.legacy("tools/list")).body.result as { tools: { name: string }[] };
      assert(!listed.tools.some((t) => t.name === name));
    }
    const raw = await s.call("raw", {}, { session: "s" });
    assertEquals(raw.body.error?.code, -32602);
    const staff = await s.call("staff", {}, { session: "s" });
    assertEquals([staff.body.result?.isError, said(staff)], [
      true,
      "That tool isn't offered here.",
    ]);
    assertEquals([runs.raw, runs.staff], [undefined, undefined]);
  });
});

test("at start: a line's mistakes stop the app", async () => {
  const start = (line: Partial<DeclaredServer>, links = true) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        mcp,
        app,
        definePlugin({
          name: "lines",
          resources: {
            mcp: { chatgpt: { ...LINE, ...line } },
            // Without its secret, the app signs nothing, and no conversation can be named.
            ...(links ? {} : { links: { secret: null } }),
          },
        }),
      ],
    }).then((runtime) => runtime.close());
  await assertRejects(() => start({}, false), Error, "links");
  await assertRejects(() => start({ tools: { nope: {} } }), Error, "isn't one of the app's tools");
  await assertRejects(() => start({ tools: { send_message: {} } }), Error, "send_message");
  await assertRejects(
    () => start({ tools: { search: { invoking: "x".repeat(65) } } }),
    Error,
    "64",
  );
  await assertRejects(() => start({ in: "" }), Error, "needs its in");
  // A line lists its tools: never an agent's, never none.
  await assertRejects(() => start({ agent: "booking" } as never), Error, "never an agent's");
  await assertRejects(() => start({ tools: undefined } as never), Error, "needs its tools");
  await assertRejects(() => start({ tools: {} }), Error, "offers no tool");
  await assertRejects(() => start({ client: "booking" }), Error, "agent's name");
  await assertRejects(() => start({ limits: { perMinute: 0 } }), Error, "perMinute");
  await assertRejects(() => start({ origins: ["chatgpt.com"] }), Error, "origin");
  await assertRejects(
    () => start({ tools: { search: { annotations: { readonly: true } as never } } }),
    Error,
    "isn't an annotation",
  );
  // How it knows who calls: a header it says why it believes.
  const settled = (caller: Record<string, unknown>, server: Record<string, unknown> = {}) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        mcp,
        app,
        definePlugin({
          name: "lines",
          resources: { caller, mcp: { chatgpt: { ...LINE, ...server } } },
        }),
      ],
    }).then((runtime) => runtime.close());
  await assertRejects(() => settled({ header: "cf-connecting-ip" }), Error, "believed");
  await assertRejects(
    () => settled({ header: "x-forwarded-for", hops: 1 }, { exempt: ["10.0.0.0"] }),
    Error,
    "CIDR",
  );
  // A list header's first entries are the caller's to write: it needs its hops.
  await assertRejects(
    () => settled({ header: "x-forwarded-for", front: "a-front-secret-long-enough" }),
    Error,
    "hops",
  );
  await assertRejects(
    () => settled({ header: "forwarded", hops: 1 }),
    Error,
    "Forwarded",
  );
  const chatty = definePlugin({
    name: "chatty",
    resources: {
      tools: {
        search: {
          description: "Takes a chat",
          input: { type: "object", properties: { chat: { type: "string" } } },
          run: () => "",
        },
      },
    },
  });
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [
          models,
          chat,
          ...access,
          mcp,
          app,
          chatty,
          definePlugin({
            name: "lines",
            resources: { mcp: { chatgpt: LINE } },
          }),
        ],
      }),
    Error,
    "handles",
  );
});
