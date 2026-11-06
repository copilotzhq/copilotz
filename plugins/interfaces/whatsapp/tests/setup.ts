/**
 * What the WhatsApp tests share: a runtime with a number connected to Launch
 * (by Ana), a fake Graph API that records what's sent, Meta's deliveries
 * (signed) and what people read.
 */
import {
  type Actor,
  type Clock,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, type Thread } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { createTickets } from "../../../../hosts/web/tickets.ts";
import { webServer } from "../../../../hosts/web/server.ts";
import { serve as listen } from "../../../../testing/mod.ts";
import { whatsapp } from "../mod.ts";
import { sign } from "../shared/signature.ts";
import type { WaMessage } from "../shared/payload.ts";

export const ana: Actor = { kind: "person", id: "ana" };
export const bob: Actor = { kind: "person", id: "bob" };
export const TOKEN = "EAAG-token-for-tests-0123456789";
export const SECRET = "app-secret-for-tests-0123";
export const PHONE_ID = "106540352242922";
export const ANA_PHONE = "5511987654321";
export const BOB_PHONE = "5521999990000";
export const STRANGER = "14155550123";

/** A paragraph of Markdown, long enough that a few need several WhatsApp messages. */
export const PARAGRAPH = "**Note.** " +
  "This is a sentence about the plan, with some detail. ".repeat(30);

/**
 * Answers what it was told. Asked for something long, a long Markdown
 * answer; asked to ask, it asks the person and waits; given their answer,
 * says it.
 */
export const echo: LlmAdapter = {
  async *generate({ messages }) {
    // What was said last, past what contexts add each turn.
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    if (last.role === "tool") {
      yield { type: "text", text: `got ${last.text}` };
      return;
    }
    const text = "text" in last ? last.text ?? "" : "";
    if (text.includes("long")) {
      yield { type: "text", text: Array.from({ length: 6 }, () => PARAGRAPH).join("\n\n") };
      return;
    }
    if (text.includes("ask me")) {
      yield {
        type: "tool_call",
        call: { id: "ask", name: "send_message", input: { to: "ana", text: "Which color?" } },
      };
      return;
    }
    yield { type: "text", text: `heard **${text}**` };
  },
};

/** What people read, as Views: what a front end would show them. */
export const reads = definePlugin({
  name: "reads",
  views: Object.fromEntries(
    [
      "whatsapp_number",
      "whatsapp_secret",
      "whatsapp_phone",
      "whatsapp_code",
      "whatsapp_thread",
      "whatsapp_rate",
      "thread",
      "message",
      "contact",
    ].map((c) => [
      c,
      (_: unknown, ctx: ViewContext) => ctx.db.collection(c).find({}).value ?? [],
    ]),
  ),
  actions: {
    // An agent's message with a file, to whoever wrote to it last in a chat.
    "test.file": defineAction({
      input: { type: "object" },
      run: async (ctx, input: { thread: string; text: string; type: string; data: string }) => {
        const [last] = await ctx.db.collection<Message>("message").find(
          { thread: input.thread, from: { $ne: "lead" } },
          { sort: { at: -1 }, limit: 1 },
        );
        const id = crypto.randomUUID();
        const file = {
          _id: `${id}:file.0`,
          name: input.type === "image/png" ? "qr.png" : "ticket.pdf",
          type: input.type,
          size: Math.floor(input.data.length * 3 / 4),
          data: input.data,
          thread: input.thread,
          ...(last.in ? { in: last.in } : {}),
          at: new Date().toISOString(),
        };
        await ctx.transaction(async (tx) => {
          await tx.db.collection("file").insertOne(file);
          await tx.db.collection("message").insertOne({
            _id: id,
            thread: input.thread,
            ...(last.in ? { in: last.in } : {}),
            from: "lead",
            to: [last.from],
            text: input.text,
            hops: 1,
            files: [{ id: file._id, name: file.name, type: file.type, size: file.size }],
            at: new Date().toISOString(),
          });
        });
        return file._id;
      },
    }),
    // "Typing…" shown a while ago, for every chat being answered.
    "test.typed": defineAction({
      input: { type: "object" },
      run: (ctx, input: { seconds: number }) =>
        ctx.db.collection("whatsapp_typing").updateMany({}, {
          $set: { shown: new Date(Date.now() - input.seconds * 1000).toISOString() },
        }),
    }),
    // An agent's message in a chat, as trusted code writes one (with what it drew on, maybe).
    "test.said": defineAction({
      input: { type: "object" },
      run: async (
        ctx,
        input: { thread: string; to: string; text: string; sources?: string[]; answer?: boolean },
      ) => {
        const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
        const turn = crypto.randomUUID();
        await ctx.db.collection("message").insertOne({
          // An answer, as a turn writes one, when it says so.
          _id: input.answer ? `${turn}:reply` : turn,
          ...(input.answer ? { turn } : {}),
          thread: input.thread,
          ...(thread?.in ? { in: thread.in } : {}),
          from: "lead",
          to: [input.to],
          text: input.text,
          hops: 1,
          ...(input.sources ? { sources: input.sources } : {}),
          at: new Date().toISOString(),
        });
      },
    }),
    // A rate count from long ago, of a phone that wrote then.
    "test.stale": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("whatsapp_rate").insertOne({ _id: "old:phone", minute: 1, count: 3 }),
    }),
    // A chat moved to another space, as the system does it.
    "test.move": defineAction({
      input: { type: "object" },
      run: (ctx, input: { thread: string; to: string }) =>
        ctx.db.collection("thread").updateOne({ _id: input.thread }, { $set: { in: input.to } }),
    }),
    // A chat gone quiet for some hours: its last message that long ago.
    "test.age": defineAction({
      input: { type: "object" },
      run: (ctx, input: { thread: string; hours: number }) =>
        ctx.db.collection("thread").updateOne({ _id: input.thread }, {
          $set: { at: new Date(Date.now() - input.hours * 3_600_000).toISOString() },
        }),
    }),
    // Meta stops taking the number's token (it expired).
    "test.expire": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("whatsapp_secret").updateMany({}, {
          $set: { token: "EAAG-expired-token-00000000" },
        }),
    }),
  },
});

export type Seen = { method: string; path: string; body?: Record<string, unknown> };

/** The Graph API, as far as the plugin uses it: a number, messages, read marks, media. */
export async function fakeGraph() {
  const requests: Seen[] = [];
  const media: Record<string, { type: string; bytes: Uint8Array }> = {
    "media-photo": { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 1, 2, 3]) },
    "media-voice": { type: "audio/ogg; codecs=opus", bytes: new Uint8Array(64).fill(7) },
    "media-doc": { type: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 plan") },
    "media-huge": { type: "video/mp4", bytes: new Uint8Array(1) },
  };
  let sent = 0;
  /** What Meta refuses (a 400, as for a part it won't take), and what fails once (a 500). */
  const refusing: { refuse?: (body: Record<string, unknown>) => boolean } = {};
  let failing: ((body: Record<string, unknown>) => boolean) | undefined;
  const server = await listen(async (request) => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: { message: "Invalid OAuth access token.", code: 190 } }, {
        status: 401,
      });
    }
    // A file uploaded comes as a form; everything else as JSON.
    const form = request.headers.get("content-type")?.startsWith("multipart/")
      ? await request.formData()
      : undefined;
    const body = form
      ? Object.fromEntries(
        [...form].map(([k, v]) => [k, typeof v === "string" ? v : `<${v.type}, ${v.size} bytes>`]),
      )
      : request.method === "POST"
      ? await request.json()
      : undefined;
    requests.push({ method: request.method, path: url.pathname, ...(body ? { body } : {}) });
    const [, version, id, more] = url.pathname.split("/");
    if (version === "files") {
      return new Response(media[id].bytes as BodyInit, {
        headers: { "content-type": media[id].type },
      });
    }
    if (/^\d+$/.test(id) && !more) {
      return Response.json({
        id,
        display_phone_number: id === PHONE_ID ? "+1 555-0100" : `+${id}`,
        verified_name: "Example Support",
      });
    }
    if (more === "media") return Response.json({ id: `media.up.${++sent}` });
    if (more === "messages" && body?.status !== "read") {
      if (failing?.(body)) {
        failing = undefined;
        return Response.json({ error: { message: "Service unavailable", code: 2 } }, {
          status: 500,
        });
      }
      if (refusing.refuse?.(body)) {
        return Response.json({
          error: { message: "(#131009) Parameter value is not valid", code: 131009 },
        }, { status: 400 });
      }
    }
    if (more === "messages") {
      return Response.json(
        body?.status === "read"
          ? { success: true }
          : { messaging_product: "whatsapp", messages: [{ id: `wamid.out.${++sent}` }] },
      );
    }
    if (media[id]) {
      return Response.json({
        url: `${server.url}/files/${id}`,
        mime_type: media[id].type,
        file_size: id === "media-huge" ? 200 * 1024 * 1024 : media[id].bytes.length,
      });
    }
    return Response.json({ error: { message: "Unknown path", code: 100 } }, { status: 404 });
  });
  return {
    url: server.url,
    close: server.close,
    requests,
    /** The texts sent to a phone, in order. */
    texts: (to: string) =>
      requests.filter((r) => r.body?.to === to && r.body?.type === "text")
        .map((r) => (r.body!.text as { body: string }).body),
    /** Every message sent to a phone (read marks aside), as the Graph API got it, in order. */
    sent: (to: string) =>
      requests.filter((r) => r.body?.to === to && r.body?.status !== "read").map((r) => r.body!),
    /** Read marks for a phone's messages that showed "typing…". */
    typing: () =>
      requests.filter((r) => r.body?.status === "read" && r.body?.typing_indicator).length,
    /** Meta refuses what this says (a 400). */
    refuse: (when?: (body: Record<string, unknown>) => boolean) => {
      refusing.refuse = when;
    },
    /** The next message this says fails once (a 500), as Meta's outages do. */
    failOnce: (when: (body: Record<string, unknown>) => boolean) => {
      failing = when;
    },
  };
}

export type Setup = {
  runtime: Runtime;
  graph: Awaited<ReturnType<typeof fakeGraph>>;
  serve(request: Request): Promise<Response>;
  launch: string;
  personal: string;
  /** The number connected to Launch, by Ana. */
  number: string;
  verify: string;
  /** Delivers messages to the number's webhook as Meta does, signed, and waits for what follows. */
  deliver(
    messages: Partial<WaMessage>[],
    options?: { from?: string; secret?: string; name?: string },
  ): Promise<Response>;
  /** What someone reads of a collection, as a View. */
  read<T>(collection: string, actor: Actor): Promise<T[]>;
  /** Lets Bob into Launch, as an editor. */
  bobJoins(): Promise<void>;
  /** Closes the runtime and starts it again on the same store (and clock): a deploy. */
  restart(): Promise<void>;
};

export async function setup(
  fn: (s: Setup) => Promise<void>,
  options: { plugins?: Plugin[]; llm?: LlmAdapter; clock?: Clock } = {},
) {
  const graph = await fakeGraph();
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: { labels: true }, file: {} },
      provider: { e: { adapter: "e" } },
      model: { transcribe: "fake/listen" },
      agents: {
        lead: { instructions: "Hi.", model: "e/lead", default: true, tools: ["send_message"] },
        desk: { instructions: "Sell.", model: "e/desk" },
      },
      whatsapp: { graph: `${graph.url}/v23.0` },
    },
    adapters: { llm: { e: options.llm ?? echo } },
  });
  const store = memoryStore();
  const start = () =>
    createRuntime({
      store,
      plugins: [models, chat, ...access, whatsapp, reads, app, ...options.plugins ?? []],
      ...(options.clock ? { clock: options.clock } : {}),
    });
  let runtime = await start();
  const serving = () =>
    webServer({
      runtime,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(null, { status: 299 }),
    });
  let serve = serving();
  try {
    const { space: personal } = await runtime.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space: launch } = await runtime.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { number, verify } = await runtime.call<{ number: string; verify: string }>(
      "whatsapp.connect",
      { in: launch, phoneId: PHONE_ID, token: TOKEN, secret: SECRET, url: "https://app.test" },
      { actor: ana },
    );
    let n = 0;
    await fn({
      get runtime() {
        return runtime;
      },
      graph,
      serve: (request) => serve(request),
      restart: async () => {
        await runtime.close();
        runtime = await start();
        serve = serving();
      },
      launch,
      personal,
      number,
      verify,
      deliver: async (messages, options = {}) => {
        const from = options.from ?? ANA_PHONE;
        const body = JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{
            id: "waba",
            changes: [{
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550100", phone_number_id: PHONE_ID },
                contacts: [{
                  profile: { name: options.name ?? (from === ANA_PHONE ? "Ana" : "Someone") },
                  wa_id: from,
                }],
                messages: messages.map((m) => ({
                  id: `wamid.in.${++n}`,
                  from,
                  timestamp: "1761800000",
                  type: "text",
                  ...m,
                })),
              },
            }],
          }],
        });
        const bytes = new TextEncoder().encode(body);
        const answered = await serve(
          new Request(`http://localhost/hooks/whatsapp/${number}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": await sign(options.secret ?? SECRET, bytes),
            },
            body,
          }),
        );
        await runtime.idle();
        return answered;
      },
      read: async <T>(collection: string, actor: Actor) => {
        const seen = runtime.observe<T[]>(collection, {}, { actor });
        const output = await seen.ready;
        seen.close();
        return output.status === "ready" ? output.value : [];
      },
      bobJoins: async () => {
        await runtime.call("person.set", { person: "bob", email: "bob@example.com" });
        const { invitation } = await runtime.call<{ invitation: string }>("invitation.send", {
          space: launch,
          email: "bob@example.com",
          role: "editor",
        }, { actor: ana });
        await runtime.call("invitation.accept", { invitation }, { actor: bob });
      },
    });
  } finally {
    await runtime.close();
    await graph.close();
  }
}

/** Links someone's phone: a code from the app, sent from that phone. */
export async function link(s: Setup, who = ana, phone = ANA_PHONE) {
  const { code } = await s.runtime.call<{ code: string }>("whatsapp.link", { number: s.number }, {
    actor: who,
  });
  await s.deliver([{ text: { body: code } }], { from: phone });
}

/** Every event, as text: what the log holds. */
export async function logged(runtime: Runtime, during: () => Promise<void>): Promise<string> {
  const seen: unknown[] = [];
  const stop = runtime.subscribe((item) => {
    if (item.kind === "event") seen.push(item.event);
  });
  try {
    await during();
    await runtime.idle();
  } finally {
    stop();
  }
  return JSON.stringify(seen);
}

export const threadsOf = (runtime: Runtime, space: string, actor = ana) =>
  runtime.query<Thread[]>("thread.recent", { in: space }, { actor });

export const said = async (runtime: Runtime, thread: string) =>
  (await runtime.query<Message[]>("message.history", { thread }, { actor: ana }))
    .filter((m) => !m.private).map((m) => [m.from, m.text]);
