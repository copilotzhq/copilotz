/**
 * What the MCP tests share: an app with one line (`chatgpt`, in the app's
 * own space) and a way to call it as a client does: JSON-RPC over HTTP to
 * the runtime, legacy (with a protocol version header) or modern
 * (2026-07-28's `_meta` and headers), from an address its front vouches for.
 *
 * The tools, each with its `tool:<name>` View (what a model reads of it):
 * `search` (read-only; its View leaves a secret out), `pick` (writes the
 * chat's booking, as the contact), `peek` (reads any chat's booking),
 * `status` (read-only: says what `paid` is now), `whoami` (says who it runs
 * as, where, and its call's ids), `boom` (a bare throw, with secrets in it),
 * `refuse` and `later` (public refusals: the runtime's code, the app's own),
 * `coded` (a coded failure that isn't public), `driver` (a library's error,
 * with a string code), `slow` (takes a while) and `staff` (offered only to
 * people); and `raw`, which has no View, so a line offering it doesn't start.
 * Each counts its runs (`runs`).
 *
 * And for an owner that stops mid-call: a store that stops at a write
 * (`stopping`), and waits on what tests watch for (`until`, `within`), or
 * for a call that's still working to answer (`untilAnswered`).
 */
import {
  type CallerSettings,
  createRuntime,
  definePlugin,
  failure,
  type Plugin,
  principalOf,
  type Runtime,
  type Store,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import type { Transaction } from "../../../../runtime/store.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, tool } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import type { Widgets } from "../../../../hosts/web/server.ts";
import { mcp } from "../mod.ts";
import type { DeclaredServer } from "../shared/settings.ts";

export const SECRET = "a-secret-for-signing-links-in-tests-0123456789";
export const MODERN = "2026-07-28";
/** The app's front's secret, and the address it says calls come from, unless a test says. */
export const FRONT = "the-front-secret-for-tests";
export const ADDRESS = "203.0.113.7";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many times each tool ran. */
export const runs: Record<string, number> = {};
const ran = (name: string) => runs[name] = (runs[name] ?? 0) + 1;

/** What `status` says. */
export const state = { paid: false };

/** What `charge` and `hang` did, by the callId each ran with; and what `hang` began. */
export const charges: string[] = [];
export const hangs: string[] = [];
export const begun: string[] = [];

const silent: LlmAdapter = {
  async *generate() {
    yield { type: "text" as const, text: "ok" };
  },
};

/** A booking: one per chat, part of it (the app's own, as a real booking app's would be). */
type Booking = { _id: string; thread: string; in: string; trip: string };

/** Every tool but `raw` reads as its output to a model (a View the app chose). */
const SHOWN = [
  "charge",
  "hang",
  "pick",
  "peek",
  "status",
  "whoami",
  "boom",
  "refuse",
  "later",
  "coded",
  "driver",
  "slow",
  "staff",
];

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
    "tool:search": (call: { output: string }) => {
      const { trips } = JSON.parse(call.output) as { trips: string[] };
      return `${trips.length} trips: ${trips.join(", ")}`;
    },
    ...Object.fromEntries(
      SHOWN.map((name) => [`tool:${name}`, (call: { output: string }) => call.output]),
    ),
  },
  resources: {
    links: { origin: "https://app.example", secret: SECRET },
    provider: { e: { adapter: "e" } },
    agents: {
      booking: {
        instructions: "Sell trips.",
        model: "e/booking",
        tools: ["search", "pick", "send_message"],
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
      status: tool({
        description: "Says whether it's paid",
        annotations: { readOnly: true },
        run: () => {
          ran("status");
          return state.paid ? "Paid." : "Not paid yet.";
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
            in: ctx.in,
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
          throw failure("invalid", "That date is in the past.", { public: true });
        },
      }),
      later: tool({
        description: "Refuses, with the app's own code",
        run: () => {
          ran("later");
          throw failure("not_now", "Search trips first: possible now: search_trips.", {
            public: true,
          });
        },
      }),
      coded: tool({
        description: "Fails with a code that isn't for callers",
        run: () => {
          ran("coded");
          throw failure("conflict", "Booking b-secret-id is held by session s-secret");
        },
      }),
      driver: tool({
        description: "Fails as a library does: a string code, internals in its words",
        run: () => {
          ran("driver");
          throw Object.assign(new Error("connect ECONNREFUSED (user=app password=hunter2)"), {
            code: "ECONNREFUSED",
          });
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
      charge: tool({
        description: "Charges, slowly, ignoring its signal (a partner's API)",
        run: async (_input, ctx) => {
          await sleep(120);
          charges.push(ctx.callId);
          return `Charged once, with key ${ctx.callId}`;
        },
      }),
      hang: tool({
        description: "The first time, takes as long as it's told, ignoring its signal; says its " +
          "callId and retry",
        input: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
        run: async (input, ctx) => {
          begun.push(ctx.callId);
          await sleep(ctx.retry ? 0 : input.ms as number);
          hangs.push(ctx.callId);
          return JSON.stringify({ callId: ctx.callId, retry: ctx.retry });
        },
      }),
      staff: tool({
        description: "Staff only: every booking in the space",
        offer: (_agent, _thread, ctx) => principalOf(ctx.actor)?.kind !== "contact",
        run: () => {
          ran("staff");
          return "EVERY BOOKING";
        },
      }),
      raw: tool({
        description: "Has no View: what it returns would go out as it is",
        run: () => {
          ran("raw");
          return "internal: password=hunter2";
        },
      }),
    },
    spaces: { line: { name: "ChatGPT", agents: ["booking"] }, review: { name: "Review" } },
    shared: { booking: { part: "thread" } },
  },
  adapters: { llm: { e: silent } },
});

/** The line every test calls, unless it says otherwise. */
export const LINE: DeclaredServer = {
  in: "line",
  client: "ChatGPT",
  title: "Viação Azul",
  instructions: "Buy bus tickets.",
  tools: {
    search: { invoking: "Searching…", invoked: "Found trips." },
    pick: { title: "Pick a trip" },
    peek: {},
    status: {},
    whoami: {},
    boom: {},
    refuse: {},
    later: {},
    coded: {},
    driver: {},
    slow: {},
    charge: {},
    hang: {},
    staff: {},
  },
};

/** The tools the line offers a contact: all but `staff` (people only). */
export const OFFERED = Object.keys(LINE.tools).filter((name) => name !== "staff");

/** How the app knows who calls: its front says, with its secret. */
export const CALLER: CallerSettings = { header: "cf-connecting-ip", front: FRONT };

/** Reads every document of the collections the tests look at, as the system. */
export const reads = definePlugin({
  name: "reads",
  views: Object.fromEntries(
    [
      "contact",
      "thread",
      "message",
      "booking",
      "member",
      "mcp_receipt",
      "mcp_rate",
      "mcp_closed",
      "mcp_opening",
    ]
      .map((c) => [
        c,
        (item: { thread?: string }, ctx: ViewContext) =>
          ctx.db.collection(c).find(item.thread ? { thread: item.thread } : {}, {
            sort: { at: 1 },
          }).value ?? [],
      ]),
  ),
});

/** Test hands: a contact taken out of its chat, a conversation erased, a chat moved, time passing. */
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
    // What `contact.forget` with its chats does, without asking who manages the space.
    "test.forget": {
      input: { type: "object" },
      run: async (ctx, input: { thread: string; contact: string; chats?: boolean }) => {
        if (input.chats !== false) await ctx.call("chat.erase", { thread: input.thread });
        await ctx.db.collection("member").deleteMany({ member: `contact:${input.contact}` });
        await ctx.db.collection("contact").deleteOne({ _id: input.contact });
      },
    },
    "test.move": {
      input: { type: "object" },
      run: async (ctx, input: { thread: string; to: string }) => {
        await ctx.call("space.keep", { id: input.to });
        await ctx.db.collection("thread").updateOne({ _id: input.thread }, {
          $set: { in: input.to },
        });
      },
    },
    // Receipts and openings begun `ms` earlier; counters of past windows gone (a minute went by).
    "test.age": {
      input: { type: "object" },
      run: async (ctx, input: { ms?: number; minute?: boolean }) => {
        for (const name of ["mcp_receipt", "mcp_opening"]) {
          const kept = ctx.db.collection<{ at: number }>(name);
          for (const r of await kept.find({})) {
            await kept.updateOne({ _id: r._id }, { $set: { at: r.at - (input.ms ?? 0) } });
          }
        }
        if (input.minute) {
          await ctx.db.collection("mcp_rate").deleteMany({ until: { $lte: Date.now() + 60_000 } });
        }
      },
    },
    // A call cut short: its receipt, as written before its tool ran, and never done.
    "test.cut": {
      input: { type: "object" },
      run: (ctx, input: { call: string; step: string }) =>
        ctx.db.collection("mcp_receipt").replaceOne(
          { _id: input.call },
          { step: input.step, at: Date.now() },
          { upsert: true },
        ),
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
    options?: { id?: unknown; line?: string; headers?: Record<string, string> },
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
    options?: {
      session?: string;
      subject?: string;
      id?: unknown;
      line?: string;
      headers?: Record<string, string>;
    },
  ): Promise<Rpc>;
  /** What's in a collection, as the system reads it (`thread` narrows it). */
  docs<T = Record<string, unknown>>(collection: string, thread?: string): Promise<T[]>;
  /** The steps written in a chat. */
  steps(thread: string): Promise<Message[]>;
};

let ids = 0;

/** Limits counted by the clock's minute or hour (each window starts on the minute). */
const WINDOWED = [
  "perMinute",
  "linePerMinute",
  "ipPerMinute",
  "chatsPerHour",
  "userChatsPerHour",
  "ipChatsPerHour",
];

/**
 * Waits out the last seconds of a minute, for a test of limits counted by
 * the clock's minute (or hour): calls it makes in one breath could fall
 * either side of the minute's end, and be counted in two windows.
 */
async function clearOfMinute(limits: Record<string, unknown> | undefined): Promise<void> {
  if (!limits || !WINDOWED.some((name) => name in limits)) return;
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 20));
}

export async function setup(
  fn: (s: Setup) => Promise<void>,
  options: {
    line?: Partial<DeclaredServer>;
    lines?: Record<string, DeclaredServer>;
    /** How the app knows who calls (the `caller` resource). */
    caller?: CallerSettings;
    plugins?: Plugin[];
    /** One store for several runtimes in turn (an owner restarted). */
    store?: Store;
    /** The app's widgets (`widgetsOf`, its `widgets` resource): the line's tools drawn by Views. */
    widgets?: Widgets;
  } = {},
) {
  await clearOfMinute(options.line?.limits as Record<string, unknown> | undefined);
  for (const key of Object.keys(runs)) delete runs[key];
  state.paid = false;
  charges.length = 0;
  hangs.length = 0;
  begun.length = 0;
  const runtime = await createRuntime({
    store: options.store ?? memoryStore(),
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
        resources: {
          caller: options.caller ?? CALLER,
          mcp: options.lines ?? { chatgpt: { ...LINE, ...options.line } },
        },
      }),
      ...options.widgets
        ? [definePlugin({ name: "widgets", resources: { widgets: options.widgets } })]
        : [],
      ...options.plugins ?? [],
    ],
  });
  const post: Setup["post"] = async (body, o = {}) => {
    const response = await runtime.fetch(
      new Request(`http://localhost/mcp/${o.line ?? "chatgpt"}`, {
        method: o.method ?? "POST",
        // As the app's front sends it: who calls, and its secret. A header said empty isn't sent.
        headers: Object.fromEntries(
          Object.entries({
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "cf-connecting-ip": ADDRESS,
            "x-copilotz-front": FRONT,
            ...o.headers,
          }).filter(([, value]) => value !== ""),
        ),
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
        {
          headers: { "mcp-protocol-version": "2025-11-25", ...o.headers },
          ...(o.line ? { line: o.line } : {}),
        },
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
      }, {
        ...(o.id !== undefined ? { id: o.id } : {}),
        ...(o.line ? { line: o.line } : {}),
        ...(o.headers ? { headers: o.headers } : {}),
      }),
    docs: async <T>(collection: string, thread?: string) => {
      const seen = runtime.observe<T[]>(collection, thread ? { thread } : {});
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
    // A test may have closed it already (an owner restarted mid-call).
    if (!closed.has(runtime)) await runtime.close();
  }
}

/** Runtimes a test closed itself. */
export const closed = new WeakSet<Runtime>();

/** A write a stopping store is asked for. */
export type Write = {
  op: "insert" | "update" | "replace" | "delete";
  collection: string;
  /** What it writes: the document inserted or replaced with, or the update. */
  doc?: Record<string, unknown>;
};

/**
 * A store whose owner stops at the first write `at` matches, as an owner's
 * process does when it ends mid-call (a deploy, a crash): that write never
 * commits, nor does anything after it. `reached` settles once the write is
 * asked for; `stop()` ends the owner. A test stops it in a `finally`, even
 * when it fails: a write held there holds the store, and whatever comes
 * next would wait for it for good.
 */
export function stopping(
  store: Store,
  at: (write: Write) => boolean,
): { store: Store; reached: Promise<void>; stop(): void } {
  const gone = () => Object.assign(new Error("The owner stopped."), { code: "fenced" });
  let stopped = false;
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => reach = resolve);
  const end = Promise.withResolvers<never>();
  end.promise.catch(() => {});
  const held = (tx: Transaction): Transaction => {
    const write = <A extends unknown[], R>(
      op: Write["op"],
      run: (collection: string, ...args: A) => Promise<R>,
      doc: (...args: A) => unknown,
    ) =>
    async (collection: string, ...args: A): Promise<R> => {
      if (stopped) throw gone();
      if (at({ op, collection, doc: doc(...args) as Write["doc"] })) {
        reach();
        await end.promise;
      }
      return await run(collection, ...args);
    };
    return {
      ...tx,
      insert: write("insert", tx.insert, (docs) => docs[0]),
      update: write("update", tx.update, (_filter, update) => update),
      replace: write("replace", tx.replace, (_filter, doc) => doc),
      delete: write("delete", tx.delete, () => undefined),
    };
  };
  return {
    // Every write through a transaction (none as a single command), each seen here.
    store: {
      ...store,
      command: undefined,
      transaction: (epoch, work, options) =>
        store.transaction(epoch, (tx) => {
          if (stopped) throw gone();
          return work(held(tx));
        }, options),
    },
    reached,
    stop: () => {
      stopped = true;
      end.reject(gone());
    },
  };
}

/** What `check` answers once it's truthy (looked at every few ms), or a failure after `ms`. */
export async function until<T>(check: () => T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Never happened: ${what}`);
    await sleep(5);
  }
}

/** `promise`, or a failure after `ms`: a test waits for nothing for good. */
export async function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Never happened: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How an answer that a call is still running (past the line's timeout) begins. */
const STILL = /^Still working on it/;

/**
 * What a call answers once it no longer answers one of `meanwhile`'s (that it's still working,
 * unless a test says): asked again until then, as a model told so does, every few ms, or a
 * failure after `ms`. How long a slow machine takes to get there isn't what a test looks at.
 */
export async function untilAnswered(
  ask: () => Promise<Rpc>,
  what: string,
  meanwhile: RegExp = STILL,
  ms = 10_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = said(await ask());
    if (!meanwhile.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`Never happened: ${what} (it said: ${text})`);
    await sleep(20);
  }
}

/** How an answer that's an earlier, identical request's begins. */
export const AGAIN =
  /^This same request was made moments ago, and it wasn't done again: [^\n]*\n\n/;

/** An answer's own words, without that line. */
export const own = (text: string) => text.replace(AGAIN, "");

/** The text an answer says. */
export const said = (rpc: Rpc) => rpc.body.result?.content?.[0]?.text ?? "";

/** The handle an answer ends with, if any. */
export const handleIn = (rpc: Rpc) => /\nchat: ([A-Za-z0-9_-]{22})$/.exec(said(rpc))?.[1];
