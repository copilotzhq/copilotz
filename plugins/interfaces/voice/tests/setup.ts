/**
 * What the voice tests share: an app with one phone line (`help`, in the
 * app's own space, answered by `phone`), a scripted model that streams its
 * words, a fake Twilio (its webhook requests, signed, and a socket that
 * plays ConversationRelay's part) and a way to wait for what follows.
 */
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Plugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, tool } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { createTickets } from "../../../../hosts/web/tickets.ts";
import { webServer } from "../../../../hosts/web/server.ts";
import { voice } from "../mod.ts";
import type { VoiceLine } from "../shared/settings.ts";
import { sign } from "../shared/signature.ts";
import { type RelaySocket, serveRelay } from "../resources/relay.ts";

export const ACCOUNT = `AC${"1".repeat(32)}`;
export const TOKEN = "twilio-auth-token-for-tests";
export const ORIGIN = "https://calls.example.com";
export const LINE_NUMBER = "+551150000000";
export const CARLA = "+5511911112222";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Words streamed a few at a time, a little apart, as a model writes. */
async function* streamed(text: string, gap = 15) {
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    await sleep(gap);
    yield { type: "text" as const, text: piece };
  }
}

/**
 * The phone agent's model, by what the caller said last: "fail" fails;
 * "slow" takes long before a word; "search" says a word first, looks (a
 * tool), then answers; "bye" says goodbye and ends the call; "long" says a
 * long answer, slowly; anything else is answered with what was heard.
 */
/** The tools the model was offered, each call: what an agent may do there. */
export const offered: string[][] = [];

export const speaker: LlmAdapter = {
  async *generate({ messages, tools }) {
    offered.push((tools ?? []).map((t) => t.name).sort());
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    if (last.role === "tool") {
      yield* streamed(last.text?.includes("call ends") ? "Até logo! " : `Encontrei ${last.text}.`);
      return;
    }
    // What they said, past who said it ("someone: …") and what they tapped.
    const words = ("text" in last ? last.text ?? "" : "").replace(/^[^:\n]+: /, "")
      .replace(/\s*\[tapped: [^\]]*\]/g, "").toLowerCase();
    if (words.includes("fail")) throw Object.assign(new Error("model down"), { final: true });
    if (words.includes("slow")) await sleep(1_500);
    if (words.includes("search")) {
      yield* streamed("Um instante, vou procurar. ");
      yield { type: "tool_call", call: { id: "s1", name: "search", input: {} } };
      return;
    }
    if (words.includes("bye")) {
      yield { type: "tool_call", call: { id: "b1", name: "end_call", input: {} } };
      return;
    }
    if (words.includes("long")) {
      yield* streamed(`${"Temos muitas viagens hoje, de manhã e à tarde. ".repeat(4)}`, 60);
      return;
    }
    // Whether the voice context told it something new this turn (after what was said last).
    const told = messages.slice(messages.indexOf(last) + 1)
      .some((m) => "text" in m && m.text?.includes('context name="voice"'));
    yield* streamed(`Você disse **${words}**.${told ? " (cut)" : ""}`);
  },
};

export type Sent = { type: string; token?: string; last?: boolean; handoffData?: string };

/** ConversationRelay's side of a call's socket: what the app sent it, and what it tells the app. */
export type Relay = {
  socket: RelaySocket;
  sent: Sent[];
  /** What was said, each utterance (up to a `last` token) joined. */
  said(): string[];
  tell(message: Record<string, unknown>): void;
  /** The caller hangs up. */
  hangUp(): void;
  closed: boolean;
};

export function fakeRelay(): Relay {
  const sent: Sent[] = [];
  const relay: Relay = {
    sent,
    closed: false,
    socket: {
      readyState: 1,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data: string) => void sent.push(JSON.parse(data)),
      close: () => {
        if (relay.closed) return;
        relay.closed = true;
        (relay.socket as { readyState: number }).readyState = 3;
        relay.socket.onclose?.({});
      },
    },
    said: () => {
      const all: string[] = [];
      let now = "";
      for (const m of sent) {
        if (m.type !== "text") continue;
        now += m.token ?? "";
        if (m.last) {
          all.push(now);
          now = "";
        }
      }
      return now ? [...all, now] : all;
    },
    tell: (message) => relay.socket.onmessage?.({ data: JSON.stringify(message) }),
    hangUp: () => relay.socket.close(),
  };
  return relay;
}

/** Waits until `ok()` says so (or fails after `ms`). */
export async function until(ok: () => boolean | Promise<boolean>, ms = 3_000, what = "it") {
  const end = Date.now() + ms;
  while (!await ok()) {
    if (Date.now() > end) throw new Error(`Waited ${ms} ms for ${what}`);
    await sleep(10);
  }
}

export type Setup = {
  runtime: Runtime;
  /** Twilio's webhook, as Twilio calls it: signed (with `token`), for a call from `from`. */
  ring(options?: {
    from?: string;
    call?: string;
    token?: string;
    path?: string;
    form?: Record<string, string>;
  }): Promise<Response>;
  /** Twilio opening a call's socket, from the TwiML it was given. */
  open(twiml: string, options?: { token?: string }): Promise<{ response: Response; relay: Relay }>;
  /** A whole call coming in: rung, its socket open, Twilio's `setup` told. */
  call(
    options?: { from?: string; call?: string; form?: Record<string, string> },
  ): Promise<Relay & { id: string }>;
  /** What's in a collection, as the system reads it (or as `actor` does). */
  docs<T = Record<string, unknown>>(collection: string, actor?: Actor): Promise<T[]>;
  /** The messages of a chat. */
  messages(thread: string): Promise<Message[]>;
};

/** A call SID, as Twilio makes them. */
export const callSid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;

/** A caller's number of its own for each call, unless a test says whose. */
export const numberFor = (n: number) => `+5521${String(900000000 + n)}`;

/** What Twilio says of a number it verified (STIR/SHAKEN's full attestation). */
export const VERIFIED = { StirVerstat: "TN-Validation-Passed-A" };

export async function setup(
  fn: (s: Setup) => Promise<void>,
  options: { line?: Partial<VoiceLine>; plugins?: Plugin[] } = {},
) {
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { e: { adapter: "e" } },
      agents: {
        phone: { instructions: "Answer calls.", model: "e/phone", tools: ["search"] },
        // An agent of the app's that doesn't work in the line's space.
        desk: { instructions: "Sell.", model: "e/desk" },
      },
      tools: {
        search: tool({
          description: "Looks for trips",
          run: async () => {
            await sleep(80);
            return "três viagens";
          },
        }),
      },
      spaces: { line: { name: "Help line", agents: ["phone"] } },
      voice: {
        lines: {
          help: {
            in: "line",
            account: ACCOUNT,
            token: TOKEN,
            origin: ORIGIN,
            agent: "phone",
            language: "pt-BR",
            ...options.line,
          },
        },
      },
    },
    adapters: { llm: { e: speaker } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, voice, reads, hands, app, ...options.plugins ?? []],
  });
  const serve = webServer({
    runtime,
    tickets: createTickets(),
    code: { entry: "app.js", files: { "app.js": "" } },
    upgrade: () => new Response(null, { status: 299 }),
  });
  let rung = 0;
  const s: Setup = {
    runtime,
    ring: async (o = {}) => {
      const path = o.path ?? "/hooks/voice/help";
      const n = ++rung;
      const from = o.from ?? numberFor(n);
      const form = new URLSearchParams({
        AccountSid: ACCOUNT,
        ApiVersion: "2010-04-01",
        CallSid: o.call ?? callSid(n),
        CallStatus: "ringing",
        Called: LINE_NUMBER,
        Caller: from,
        Direction: "inbound",
        From: from,
        To: LINE_NUMBER,
        ...o.form,
      });
      return await serve(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": await sign(o.token ?? TOKEN, `${ORIGIN}${path}`, form),
          },
          body: form.toString(),
        }),
      );
    },
    open: async (twiml, o = {}) => {
      const url = /url="([^"]+)"/.exec(twiml)?.[1]?.replaceAll("&amp;", "&");
      if (!url) throw new Error(`No socket in ${twiml}`);
      const relay = fakeRelay();
      const at = new URL(url);
      const response = await serveRelay(
        new Request(`http://localhost${at.pathname}${at.search}`, {
          headers: {
            upgrade: "websocket",
            "x-twilio-signature": await sign(o.token ?? TOKEN, url),
          },
        }),
        {
          runtime,
          upgrade: () => ({ socket: relay.socket, response: new Response(null, { status: 200 }) }),
        },
      );
      return { response, relay };
    },
    call: async (o = {}) => {
      const n = rung + 1;
      const id = o.call ?? callSid(n);
      const from = o.from ?? numberFor(n);
      const twiml = await (await s.ring({ ...o, from, call: id })).text();
      const { response, relay } = await s.open(twiml);
      if (response.status !== 200) throw new Error(`No socket: ${await response.text()}`);
      relay.tell({
        type: "setup",
        sessionId: `VX${"a".repeat(32)}`,
        accountSid: ACCOUNT,
        callSid: id,
        from,
        to: LINE_NUMBER,
        direction: "inbound",
        customParameters: {},
      });
      await until(
        async () =>
          (await s.docs<{ _id: string; state: string }>("voice_call"))
            .some((c) => c._id === id && c.state === "live"),
        3_000,
        "the call to start",
      );
      return Object.assign(relay, { id });
    },
    docs: async <T>(collection: string, actor?: Actor) => {
      const seen = runtime.observe<T[]>(`test:${collection}`, {}, actor ? { actor } : {});
      const output = await seen.ready;
      seen.close();
      return output.status === "ready" ? output.value : [];
    },
    messages: async (thread) => {
      const seen = runtime.observe<Message[]>("test:message", { thread });
      const output = await seen.ready;
      seen.close();
      return output.status === "ready" ? output.value : [];
    },
  };
  try {
    await fn(s);
  } finally {
    await runtime.close();
  }
}

/** Reads every document of the collections the tests look at, as the system: Views for them. */
export const reads = definePlugin({
  name: "reads",
  views: Object.fromEntries(
    ["voice_call", "voice_phone", "voice_blocked", "contact", "thread", "message"].map((c) => [
      `test:${c}`,
      (item: { thread?: string }, ctx: ViewContext) =>
        ctx.db.collection(c).find(item.thread ? { thread: item.thread } : {}, {
          sort: { at: 1 },
        }).value ?? [],
    ]),
  ),
});

/** The caller says something, as Twilio tells it once they've finished. */
export const say = (relay: Relay, words: string) =>
  relay.tell({ type: "prompt", voicePrompt: words, lang: "pt-BR", last: true });

/** Waits for the `n`th thing said, whole, and gives all that was said. */
export const heard = async (relay: Relay, n: number, ms = 3_000) => {
  await until(() => relay.sent.filter((m) => m.type === "text" && m.last).length >= n, ms, `${n}`);
  return relay.said();
};

/** Test hands: a chat gone quiet, calls aged, a contact erased, a person in the line's space. */
export const hands = definePlugin({
  name: "hands",
  actions: {
    "test.quiet": {
      input: { type: "object" },
      run: (ctx, input: { thread: string; hours: number }) =>
        ctx.db.collection("thread").updateOne({ _id: input.thread }, {
          $set: { at: new Date(Date.now() - input.hours * 3_600_000).toISOString() },
        }),
    },
    // A call back in time: when it rang (`at`) and, unless `held`, its place (`until`).
    "test.age": {
      input: { type: "object" },
      run: async (ctx, input: { call: string; ms: number; held?: boolean }) => {
        const calls = ctx.db.collection<{ at: string; until: string }>("voice_call");
        const found = await calls.findOne({ _id: input.call });
        await calls.updateOne({ _id: input.call }, {
          $set: {
            at: new Date(Date.parse(found!.at) - input.ms).toISOString(),
            ...(input.held
              ? {}
              : { until: new Date(Date.parse(found!.until) - input.ms).toISOString() }),
          },
        });
      },
    },
    // A block that has run out.
    "test.expire": {
      input: { type: "object" },
      run: (ctx, input: { block: string }) =>
        ctx.db.collection("voice_blocked").updateOne({ _id: input.block }, {
          $set: { until: new Date(Date.now() - 1_000).toISOString() },
        }),
    },
    "test.erase": {
      input: { type: "object" },
      run: (ctx, input: { contact: string }) =>
        ctx.db.collection("contact").deleteOne({ _id: input.contact }),
    },
    // A person in the line's space, with a role.
    "test.member": {
      input: { type: "object" },
      run: (ctx, input: { person: string; role: string }) =>
        ctx.db.collection("member").insertOne({
          _id: `line|person:${input.person}`,
          member: `person:${input.person}`,
          space: "line",
          role: input.role,
        }),
    },
  },
});
