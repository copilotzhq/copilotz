/**
 * What the MCP tests share: an app with one line (`chatgpt`, in the app's
 * own space, offering the booking agent's tools) and a way to call it as a
 * client does: JSON-RPC over HTTP to the web host, legacy (with a protocol
 * version header) or modern (2026-07-28's `_meta` and headers).
 *
 * The tools: `search` (read-only, with a `tool:search` View, as agents read
 * it), `pick` (writes the chat's booking, as the contact), `peek` (reads any
 * chat's booking), `whoami` (says who it runs as, and where), `boom` (an
 * error that's not for the caller), `refuse` and `later` (ones that are: the
 * runtime's code, and the app's own), `inside` (the runtime's own code, about
 * its insides), `slow` (takes a while). Each counts its runs (`runs`).
 */
import {
  createRuntime,
  definePlugin,
  failure,
  type Plugin,
  principalOf,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, tool } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { createTickets } from "../../../../hosts/web/tickets.ts";
import { webServer } from "../../../../hosts/web/server.ts";
import { mcp } from "../mod.ts";
import type { McpLine } from "../shared/settings.ts";

export const SECRET = "a-secret-for-signing-links-in-tests-0123456789";
export const MODERN = "2026-07-28";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many times each tool ran. */
export const runs: Record<string, number> = {};
const ran = (name: string) => runs[name] = (runs[name] ?? 0) + 1;

const silent: LlmAdapter = {
  async *generate() {
    yield { type: "text" as const, text: "ok" };
  },
};

/** A booking: one per chat, part of it (the app's own, as Mobizap's is). */
type Booking = { _id: string; thread: string; in: string; trip: string };

export const app = definePlugin({
  name: "app",
  collections: {
    booking: {
      schema: {
        type: "object",
        properties: {
          thread: { type: "string" },
          in: { type: "string" },
          trip: { type: "string" },
        },
        required: ["thread", "in", "trip"],
      },
    },
  },
  views: {
    // As the app's agents read a search: a line, not the data.
    "tool:search": {
      llm: (call: { output: string }) => {
        const { trips } = JSON.parse(call.output) as { trips: string[] };
        return `${trips.length} trips: ${trips.join(", ")}`;
      },
    },
  },
  resources: {
    links: { origin: "https://app.example", secret: SECRET },
    provider: { e: { adapter: "e" } },
    agents: {
      booking: {
        instructions: "Sell trips.",
        model: "e/booking",
        tools: [
          ...["search", "pick", "peek", "whoami", "boom", "refuse", "later", "inside", "slow"],
          "send_message",
        ],
      },
    },
    tools: {
      search: tool({
        description: "Finds trips to a city",
        title: "Search trips",
        annotations: { readOnly: true },
        input: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
          additionalProperties: false,
        },
        run: (input) => {
          ran("search");
          return {
            trips: [`${input.to} 10:30`, `${input.to} 14:00`],
            secret: "kept out by its View",
          };
        },
      }),
      pick: tool({
        description: "Picks a trip for this chat's booking",
        input: {
          type: "object",
          properties: { trip: { type: "string" } },
          required: ["trip"],
          additionalProperties: false,
        },
        run: async (input, ctx) => {
          ran("pick");
          const thread = await ctx.db.collection<{ in: string }>("thread").findOne({
            _id: ctx.thread,
          });
          await ctx.db.collection("booking").replaceOne(
            { _id: ctx.thread },
            { thread: ctx.thread, in: thread!.in, trip: input.trip },
            { upsert: true },
          );
          return `Picked ${input.trip}.`;
        },
      }),
      peek: tool({
        description: "Reads a chat's booking",
        input: { type: "object", properties: { thread: { type: "string" } } },
        run: async (input, ctx) => {
          ran("peek");
          const found = await ctx.db.collection<Booking>("booking").findOne({
            _id: (input.thread as string | undefined) ?? ctx.thread,
          });
          return found ? `Booked: ${found.trip}` : "No booking.";
        },
      }),
      whoami: tool({
        description: "Says who runs it",
        run: (_input, ctx) => {
          ran("whoami");
          const who = principalOf(ctx.actor);
          return JSON.stringify({
            kind: who?.kind,
            id: who?.id,
            mcp: ctx.actor?.mcp,
            client: ctx.actor?.client,
            agent: ctx.agent,
            thread: ctx.thread,
            trigger: ctx.trigger,
            callId: ctx.callId,
            retry: ctx.retry,
          });
        },
      }),
      boom: tool({
        description: "Fails inside",
        run: () => {
          ran("boom");
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)");
        },
      }),
      refuse: tool({
        description: "Refuses what was asked",
        run: () => {
          ran("refuse");
          throw failure("invalid", "That date is in the past.");
        },
      }),
      later: tool({
        description: "Refuses, with the app's own code",
        run: () => {
          ran("later");
          throw failure("not_now", "Search trips first: possible now: search_trips.");
        },
      }),
      inside: tool({
        description: "Fails with one of the runtime's own codes",
        run: () => {
          ran("inside");
          throw failure("duplicate_key", "Duplicate key in booking: b-secret-id");
        },
      }),
      slow: tool({
        description: "Takes a while",
        annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
        run: async () => {
          ran("slow");
          await sleep(150);
          return "Done, slowly.";
        },
      }),
    },
    spaces: { line: { name: "ChatGPT", agents: ["booking"] } },
    shared: { booking: { part: "thread" } },
  },
  adapters: { llm: { e: silent } },
});

/** The line every test calls, unless it says otherwise. */
export const LINE: McpLine = {
  in: "line",
  agent: "booking",
  client: "ChatGPT",
  title: "Mobifácil",
  instructions: "Buy bus tickets.",
  tools: {
    search: { invoking: "Searching…", invoked: "Found trips." },
    pick: { title: "Pick a trip" },
    peek: {},
    whoami: {},
    boom: {},
    refuse: {},
    later: {},
    inside: {},
    slow: {},
  },
};

/** Reads every document of the collections the tests look at, as the system. */
export const reads = definePlugin({
  name: "reads",
  views: Object.fromEntries(
    ["contact", "thread", "message", "booking", "member", "mcp_call"].map((c) => [
      c,
      {
        test: (item: { thread?: string }, ctx) =>
          ctx.db.collection(c).find(item.thread ? { thread: item.thread } : {}, {
            sort: { at: 1 },
          }).value ?? [],
      },
    ]),
  ),
});

/** Test hands: a contact taken out of its chat, a receipt aged. */
export const hands = definePlugin({
  name: "hands",
  actions: {
    "test.out": {
      input: { type: "object" },
      run: (ctx, input: { thread: string; contact: string }) =>
        ctx.db.collection("member").deleteOne({
          _id: `thread:${input.thread}|contact:${input.contact}`,
        }),
    },
    "test.age": {
      input: { type: "object" },
      run: async (ctx, input: { ms: number }) => {
        const calls = ctx.db.collection<{ at: number }>("mcp_call");
        for (const c of await calls.find({})) {
          await calls.updateOne({ _id: c._id }, { $set: { at: c.at - input.ms } });
        }
      },
    },
  },
});

export type Rpc = {
  status: number;
  headers: Headers;
  body: Record<string, unknown> & {
    result?: Record<string, unknown> & { content?: { type: string; text: string }[] };
    error?: { code: number; message: string; data?: unknown };
  };
  text: string;
};

export type Setup = {
  runtime: Runtime;
  /** Posts `body` to a line as it is (a client's raw request). */
  post(
    body: unknown,
    options?: { headers?: Record<string, string>; line?: string; method?: string },
  ): Promise<Rpc>;
  /** A legacy request (`MCP-Protocol-Version: 2025-11-25`). */
  legacy(
    method: string,
    params?: Record<string, unknown>,
    options?: { id?: unknown; line?: string },
  ): Promise<Rpc>;
  /** A modern request: 2026-07-28's `_meta` and headers. */
  modern(
    method: string,
    params?: Record<string, unknown>,
    options?: { id?: unknown; headers?: Record<string, string> },
  ): Promise<Rpc>;
  /** A tool call as ChatGPT makes it: `openai/session` (and `openai/subject`) in `_meta`. */
  call(
    tool: string,
    input?: Record<string, unknown>,
    options?: { session?: string; subject?: string; id?: unknown; line?: string },
  ): Promise<Rpc>;
  /** What's in a collection, as the system reads it (`thread` narrows it). */
  docs<T = Record<string, unknown>>(collection: string, thread?: string): Promise<T[]>;
  /** The steps written in a chat. */
  steps(thread: string): Promise<Message[]>;
};

let ids = 0;

export async function setup(
  fn: (s: Setup) => Promise<void>,
  options: { line?: Partial<McpLine>; lines?: Record<string, McpLine>; plugins?: Plugin[] } = {},
) {
  for (const key of Object.keys(runs)) delete runs[key];
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      mcp,
      reads,
      hands,
      app,
      definePlugin({
        name: "lines",
        resources: { mcp: { lines: options.lines ?? { chatgpt: { ...LINE, ...options.line } } } },
      }),
      ...options.plugins ?? [],
    ],
  });
  const serve = webServer({
    runtime,
    tickets: createTickets(),
    code: { entry: "app.js", files: { "app.js": "" } },
    upgrade: () => new Response(null, { status: 501 }),
  });
  const post: Setup["post"] = async (body, o = {}) => {
    const response = await serve(
      new Request(`http://localhost/mcp/${o.line ?? "chatgpt"}`, {
        method: o.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...o.headers,
        },
        ...(o.method && o.method !== "POST"
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  };
  const s: Setup = {
    runtime,
    post,
    legacy: (method, params, o = {}) =>
      post(
        { jsonrpc: "2.0", id: "id" in o ? o.id : ++ids, method, ...(params ? { params } : {}) },
        { headers: { "mcp-protocol-version": "2025-11-25" }, ...(o.line ? { line: o.line } : {}) },
      ),
    modern: (method, params = {}, o = {}) =>
      post(
        {
          jsonrpc: "2.0",
          id: "id" in o ? o.id : ++ids,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
              ...(params._meta as Record<string, unknown> | undefined),
            },
          },
        },
        {
          headers: {
            "mcp-protocol-version": MODERN,
            "mcp-method": method,
            ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
            ...o.headers,
          },
        },
      ),
    call: (name, input = {}, o = {}) =>
      s.legacy("tools/call", {
        name,
        arguments: input,
        ...(o.session !== undefined
          ? {
            _meta: {
              "openai/session": o.session,
              ...(o.subject ? { "openai/subject": o.subject } : {}),
            },
          }
          : {}),
      }, { ...(o.id !== undefined ? { id: o.id } : {}), ...(o.line ? { line: o.line } : {}) }),
    docs: async <T>(collection: string, thread?: string) => {
      const seen = runtime.observe<T[]>("test", collection, thread ? { thread } : {});
      const output = await seen.ready;
      seen.close();
      return output.status === "ready" ? output.value : [];
    },
    steps: async (thread) =>
      (await s.docs<Message>("message", thread)).filter((m) => m.toolCalls?.length),
  };
  try {
    await fn(s);
  } finally {
    await runtime.close();
  }
}

/** The text an answer says. */
export const said = (rpc: Rpc) => rpc.body.result?.content?.[0]?.text ?? "";

/** The handle an answer ends with, if any. */
export const handleIn = (rpc: Rpc) => /\nchat: ([A-Za-z0-9_-]{22})$/.exec(said(rpc))?.[1];
