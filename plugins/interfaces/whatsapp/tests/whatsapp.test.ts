/**
 * WhatsApp, against a fake Graph API: connecting a number (its managers
 * only, its credentials out of every event and reader), the webhook (Meta's
 * signature first, its verify handshake), strangers told how to link once
 * a day, linking by code, messages to agents as their person and answers
 * back, Meta's retries, media, long answers, commands, an agent waiting on
 * the person, someone who left, and a token Meta refuses.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat, type Message, type Thread } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { createTickets } from "../../../../hosts/web/tickets.ts";
import { webServer } from "../../../../hosts/web/server.ts";
import { serve as listen, test } from "../../../../testing/mod.ts";
import { whatsapp, type WhatsAppNumber, type WhatsAppPhone } from "../mod.ts";
import { sign } from "../shared/signature.ts";
import { toWhatsApp } from "../shared/text.ts";
import type { WaMessage } from "../shared/payload.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const TOKEN = "EAAG-token-for-tests-0123456789";
const SECRET = "app-secret-for-tests-0123";
const PHONE_ID = "106540352242922";
const ANA_PHONE = "5511987654321";
const BOB_PHONE = "5521999990000";
const STRANGER = "14155550123";

/** A paragraph of Markdown, long enough that a few need several WhatsApp messages. */
const PARAGRAPH = "**Note.** " + "This is a sentence about the plan, with some detail. ".repeat(30);

/**
 * Answers what it was told. Asked for something long, a long Markdown
 * answer; asked to ask, it asks the person and waits; given their answer,
 * says it.
 */
const echo: LlmAdapter = {
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
const reads = definePlugin({
  name: "reads",
  views: Object.fromEntries(
    ["whatsapp_number", "whatsapp_secret", "whatsapp_phone", "whatsapp_code"].map((c) => [
      c,
      { test: (_: unknown, ctx: ViewContext) => ctx.db.collection(c).find({}).value ?? [] },
    ]),
  ),
  actions: {
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

type Seen = { method: string; path: string; body?: Record<string, unknown> };

/** The Graph API, as far as the plugin uses it: a number, messages, read marks, media. */
async function fakeGraph() {
  const requests: Seen[] = [];
  const media: Record<string, { type: string; bytes: Uint8Array }> = {
    "media-photo": { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 1, 2, 3]) },
    "media-voice": { type: "audio/ogg; codecs=opus", bytes: new Uint8Array(64).fill(7) },
    "media-doc": { type: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 plan") },
    "media-huge": { type: "video/mp4", bytes: new Uint8Array(1) },
  };
  let sent = 0;
  const server = await listen(async (request) => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: { message: "Invalid OAuth access token.", code: 190 } }, {
        status: 401,
      });
    }
    const body = request.method === "POST" ? await request.json() : undefined;
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
  };
}

type Setup = {
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
    options?: { from?: string; secret?: string },
  ): Promise<Response>;
  /** What someone reads of a collection, as a View. */
  read<T>(collection: string, actor: Actor): Promise<T[]>;
  /** Lets Bob into Launch, as an editor. */
  bobJoins(): Promise<void>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const graph = await fakeGraph();
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: { labels: true }, file: {} },
      provider: { e: { adapter: "e" } },
      model: { transcribe: "fake/listen" },
      agents: {
        lead: { instructions: "Hi.", model: "e/lead", default: true, tools: ["send_message"] },
      },
      whatsapp: { graph: `${graph.url}/v23.0` },
    },
    adapters: { llm: { e: echo } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, whatsapp, reads, app],
  });
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
    const serve = webServer({
      runtime,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(null, { status: 299 }),
    });
    let n = 0;
    await fn({
      runtime,
      graph,
      serve,
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
                  profile: { name: from === ANA_PHONE ? "Ana" : "Someone" },
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
        const seen = runtime.observe<T[]>("test", collection, {}, { actor });
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
async function link(s: Setup, who = ana, phone = ANA_PHONE) {
  const { code } = await s.runtime.call<{ code: string }>("whatsapp.link", { number: s.number }, {
    actor: who,
  });
  await s.deliver([{ text: { body: code } }], { from: phone });
}

/** Every event, as text: what the log holds. */
async function logged(runtime: Runtime, during: () => Promise<void>): Promise<string> {
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

const threadsOf = (runtime: Runtime, space: string, actor = ana) =>
  runtime.query<Thread[]>("thread.recent", { in: space }, { actor });

const said = async (runtime: Runtime, thread: string) =>
  (await runtime.query<Message[]>("message.history", { thread }, { actor: ana }))
    .filter((m) => !m.private).map((m) => [m.from, m.text]);

test("connecting a number: its managers only, its token tried, its credentials out of sight", async () => {
  await setup(async ({ runtime, launch, number, read, bobJoins }) => {
    await bobJoins();
    const connect = (actor: Actor, input: Record<string, unknown>) =>
      runtime.call("whatsapp.connect", {
        in: launch,
        phoneId: "222222",
        token: TOKEN,
        secret: SECRET,
        ...input,
      }, { actor });
    await assertRejects(() => connect(bob, {}), Error, "Only those who manage this space");
    await assertRejects(
      () => runtime.call("whatsapp.webhook", { number }, { actor: bob }),
      Error,
      "Only those who manage this space",
    );
    // A token Meta refuses: nothing is connected. The same number twice: no.
    await assertRejects(
      () => connect(ana, { phoneId: "333333", token: "EAAG-not-the-right-token-000" }),
      Error,
      "Meta didn't accept",
    );
    await assertRejects(() => connect(ana, { phoneId: PHONE_ID }), Error, "connected already");
    // Members read what Meta says it is; nobody outside reads its credentials.
    const [shown] = await read<WhatsAppNumber>("whatsapp_number", bob);
    assertEquals([shown.phone, shown.name, shown.in], ["+1 555-0100", "Example Support", launch]);
    const secrets = JSON.stringify([
      await read("whatsapp_secret", bob),
      await read("whatsapp_secret", ana),
    ]);
    assert(!secrets.includes(TOKEN) && !secrets.includes(SECRET), secrets);
    assertEquals(await read("whatsapp_number", { kind: "person", id: "carol" }), []);
    // Its managers see where its webhook is.
    const webhook = await runtime.call<{ path: string; verify: string }>("whatsapp.webhook", {
      number,
    }, { actor: ana });
    assertEquals(webhook.path, `/hooks/whatsapp/${number}`);
    assert(webhook.verify.length >= 20);
    // Connecting one and disconnecting it: the log never has its credentials.
    const log = await logged(runtime, async () => {
      const { number: other } = await connect(ana, {}) as { number: string };
      await runtime.call("whatsapp.disconnect", { number: other }, { actor: ana });
    });
    assert(log.includes("whatsapp_number.created") && log.includes("whatsapp_number.deleted"));
    assert(!log.includes(TOKEN) && !log.includes(SECRET), log);
  });
});

test("the webhook: Meta's verify handshake, and its signature checked before anything else", async () => {
  await setup(async ({ runtime, serve, number, verify, deliver, graph }) => {
    const hook = `http://localhost/hooks/whatsapp/${number}`;
    const handshake = await serve(
      new Request(`${hook}?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=42xyz`),
    );
    assertEquals([handshake.status, await handshake.text()], [200, "42xyz"]);
    const wrong = await serve(
      new Request(`${hook}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42xyz`),
    );
    assertEquals(wrong.status, 403);
    assertEquals((await serve(new Request("http://localhost/hooks/whatsapp/nope"))).status, 404);
    // Unsigned, or signed with another secret: refused, and nothing on record.
    const log = await logged(runtime, async () => {
      const unsigned = await serve(
        new Request(hook, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        }),
      );
      assertEquals(unsigned.status, 401);
      const forged = await deliver([{ text: { body: "hi" } }], {
        secret: "not-the-app-secret-000",
      });
      assertEquals(forged.status, 401);
    });
    assertEquals(log, "[]");
    assertEquals(graph.requests.filter((r) => r.method === "POST").length, 0);
  });
});

test("a stranger is told how to link, once a day, and nothing else", async () => {
  await setup(async ({ runtime, graph, deliver, launch, personal }) => {
    assertEquals((await deliver([{ text: { body: "hello?" } }], { from: STRANGER })).status, 200);
    await deliver([{ text: { body: "anyone?" } }], { from: STRANGER });
    const told = graph.texts(STRANGER);
    assertEquals(told.length, 1);
    assert(told[0].includes("link this phone") && told[0].includes("https://app.test"));
    assertEquals(await threadsOf(runtime, launch), []);
    assertEquals(await threadsOf(runtime, personal), []);
  });
});

test("a code links a phone to its person, once; wrong ones don't, and guessing stops", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, number, read } = s;
    const { code, phone } = await runtime.call<{ code: string; phone: string }>(
      "whatsapp.link",
      { number },
      { actor: ana },
    );
    assertEquals([code.length, phone], [6, "+1 555-0100"]);
    // She sees her code; nobody else does. Bob isn't in Launch: no code for him.
    assertEquals((await read<{ code: string }>("whatsapp_code", ana)).map((c) => c.code), [code]);
    assertEquals(await read("whatsapp_code", bob), []);
    await assertRejects(() => runtime.call("whatsapp.link", { number }, { actor: bob }));
    // Guessing: five tries answered, then silence.
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 7; i++) await deliver([{ text: { body: wrong } }], { from: STRANGER });
    assertEquals(graph.texts(STRANGER).filter((t) => t.includes("didn't match")).length, 5);
    // From Ana's phone, the code links it, written any way.
    await deliver([{ text: { body: `link ${code.slice(0, 3)} ${code.slice(3)}` } }]);
    const [welcome] = graph.texts(ANA_PHONE);
    assert(welcome.startsWith("You're linked, Ana!") && welcome.includes("*Personal*"), welcome);
    const [mine] = await read<WhatsAppPhone>("whatsapp_phone", ana);
    assertEquals([mine.person, mine.phone, mine.name], ["ana", ANA_PHONE, "Ana"]);
    assertEquals(await read("whatsapp_phone", bob), []);
    assertEquals(await read("whatsapp_code", ana), []);
    // It worked once.
    await deliver([{ text: { body: code } }], { from: "14155550999" });
    assert(graph.texts("14155550999")[0].includes("didn't match"));
    // Unlinked from the app: a stranger again.
    await runtime.call("whatsapp.unlink", { number }, { actor: ana });
    await deliver([{ text: { body: "hi" } }]);
    assert(graph.texts(ANA_PHONE).at(-1)!.includes("link this phone"));
  });
});

test("a linked phone's message reaches the agents as its person, and their answer goes back", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    const before = graph.requests.length;
    await deliver([{ text: { body: "hello there" } }]);
    // It went to Ana's Personal space, as her, in a conversation of its own.
    const [thread] = await threadsOf(runtime, personal);
    assertEquals(await said(runtime, thread._id), [
      ["ana", "hello there"],
      ["lead", "heard **ana: hello there**"],
    ]);
    // Read, typing, and the answer, as WhatsApp formats it.
    const after = graph.requests.slice(before).map((r) => r.body);
    assertEquals([after[0]?.status, after[0]?.typing_indicator], ["read", { type: "text" }]);
    assertEquals(graph.texts(ANA_PHONE).at(-1), "heard *ana: hello there*");
    // Her message isn't marked as drawing on the number's space.
    const [mine] = await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    });
    assertEquals(mine.sources, undefined);
    // The next message goes on in that conversation.
    await deliver([{ text: { body: "and more" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 1);
    assertEquals(graph.texts(ANA_PHONE).at(-1), "heard *ana: and more*");
  });
});

test("Meta delivering a message again changes nothing", async () => {
  await setup(async (s) => {
    const { runtime, graph, serve, number, personal } = s;
    await link(s);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: PHONE_ID },
            messages: [{ id: "wamid.same", from: ANA_PHONE, type: "text", text: { body: "once" } }],
          },
        }],
      }],
    });
    const signature = await sign(SECRET, new TextEncoder().encode(body));
    for (let i = 0; i < 3; i++) {
      const answered = await serve(
        new Request(`http://localhost/hooks/whatsapp/${number}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body,
        }),
      );
      assertEquals(answered.status, 200);
      await runtime.idle();
    }
    const [thread] = await threadsOf(runtime, personal);
    assertEquals((await said(runtime, thread._id)).length, 2);
    assertEquals(graph.texts(ANA_PHONE).filter((t) => t.includes("once")).length, 1);
  });
});

test("photos, documents and voice notes come as files; a voice note is transcribed", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    await deliver([{
      type: "image",
      image: { id: "media-photo", mime_type: "image/jpeg", caption: "our logo" },
    }]);
    await deliver([{
      type: "document",
      document: { id: "media-doc", mime_type: "application/pdf", filename: "plan.pdf" },
    }]);
    await deliver([{
      type: "audio",
      audio: { id: "media-voice", mime_type: "audio/ogg; codecs=opus", voice: true },
    }]);
    await deliver([{ type: "video", video: { id: "media-huge", mime_type: "video/mp4" } }]);
    await deliver([{ type: "reaction", reaction: { emoji: "👍" } }]);
    const [thread] = await threadsOf(runtime, personal);
    const mine = (await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    })).filter((m) => m.from === "ana");
    assertEquals(mine.map((m) => [m.text, m.files?.map((f) => [f.name, f.type, f.size])]), [
      ["our logo", [["photo.jpg", "image/jpeg", 6]]],
      ["", [["plan.pdf", "application/pdf", 13]]],
      ["", [["voice-note.ogg", "audio/ogg; codecs=opus", 64]]],
    ]);
    assert(mine[2].files?.[0].transcript?.startsWith("(A recording,"));
    const texts = graph.texts(ANA_PHONE);
    assert(texts.some((t) => t.includes("over 10 MB")));
    assert(texts.at(-1)!.includes("can't pass that kind of message on"));
  });
});

test("a long answer goes in parts, each within WhatsApp's limit, as WhatsApp formats it", async () => {
  await setup(async (s) => {
    const { graph, deliver } = s;
    await link(s);
    await deliver([{ text: { body: "something long, please" } }]);
    const parts = graph.texts(ANA_PHONE).slice(1);
    assert(parts.length >= 3, `${parts.length} parts`);
    assert(parts.every((p) => p.length <= 4096));
    assert(parts.every((p) => p.startsWith("*Note.*")));
    // Nothing lost, nothing added: cut between paragraphs.
    const whole = Array.from({ length: 6 }, () => PARAGRAPH.trim().replace("**Note.**", "*Note.*"));
    assertEquals(parts.join("\n\n"), whole.join("\n\n"));
  });
});

test("/new starts a new conversation; /space moves to another, by name", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal, launch, number } = s;
    await link(s);
    const last = () => graph.texts(ANA_PHONE).at(-1)!;
    await deliver([{ text: { body: "first" } }]);
    await deliver([{ text: { body: "/new" } }]);
    assert(last().startsWith("Starting fresh"));
    await deliver([{ text: { body: "second" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 2);
    await deliver([{ text: { body: "/space" } }]);
    assertEquals(
      last(),
      "You're talking in *Personal*.\nYour spaces: Personal, Launch.\n\nSend /space <name> to switch.",
    );
    await deliver([{ text: { body: "/space nowhere" } }]);
    assert(last().startsWith('No space called "nowhere"'));
    await deliver([{ text: { body: "/space laun" } }]);
    assert(last().startsWith("Now talking in *Launch*"));
    await deliver([{ text: { body: "in launch" } }]);
    const [there] = await threadsOf(runtime, launch);
    assertEquals(await said(runtime, there._id), [
      ["ana", "in launch"],
      ["lead", "heard **ana: in launch**"],
    ]);
    // From the app too.
    await runtime.call("whatsapp.move", { number, space: personal }, { actor: ana });
    await deliver([{ text: { body: "back home" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 3);
    await deliver([{ text: { body: "/help" } }]);
    assert(last().includes("/space <name>"));
    // Not a command: a message like any other.
    await deliver([{ text: { body: "/etc/hosts is broken" } }]);
    assert(last().includes("/etc/hosts is broken"));
  });
});

test("an agent waiting on the person: their answer from WhatsApp is the reply it waits for", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    await deliver([{ text: { body: "please ask me something" } }]);
    // The question reached her phone.
    assertEquals(graph.texts(ANA_PHONE).at(-1), "Which color?");
    await deliver([{ text: { body: "blue" } }]);
    const [thread] = await threadsOf(runtime, personal);
    const history = await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    });
    const question = history.find((m) => m.text === "Which color?")!;
    const answer = history.find((m) => m.text === "blue")!;
    // Her answer is the reply the agent waited for: its turn went on with it.
    assertEquals(answer.replyTo, question._id);
    assertEquals(answer.to, ["lead"]);
    const last = history.at(-1)!;
    assertEquals([last.from, last.turn !== undefined], ["lead", true]);
    assertEquals(graph.texts(ANA_PHONE).at(-1), toWhatsApp(last.text ?? ""));
  });
});

test("someone who left the number's space is unlinked, and told why", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, launch, bobJoins } = s;
    await bobJoins();
    await link(s, bob, BOB_PHONE);
    assert(graph.texts(BOB_PHONE)[0].startsWith("You're linked"));
    await runtime.call("space.leave", { space: launch }, { actor: bob });
    await deliver([{ text: { body: "still there?" } }], { from: BOB_PHONE });
    assert(graph.texts(BOB_PHONE).at(-1)!.startsWith("You're no longer in the space"));
    assertEquals(await runtime.query("thread.recent", {}, { actor: bob }), []);
    // A stranger now.
    await deliver([{ text: { body: "hello" } }], { from: BOB_PHONE });
    assert(graph.texts(BOB_PHONE).at(-1)!.includes("link this phone"));
  });
});

test("a token Meta refuses is noted on the number, until it's replaced", async () => {
  await setup(async (s) => {
    const { runtime, deliver, number, read, personal } = s;
    await link(s);
    await runtime.call("test.expire", {});
    await deliver([{ text: { body: "hi" } }]);
    // Her message reached the agents; their answer couldn't go out, and its managers see why.
    const [thread] = await threadsOf(runtime, personal);
    assertEquals((await said(runtime, thread._id)).length, 2);
    const [shown] = await read<WhatsAppNumber>("whatsapp_number", ana);
    assert(shown.problem?.includes("refused its access token"));
    await runtime.call("whatsapp.credentials", { number, token: TOKEN }, { actor: ana });
    const [fixed] = await read<WhatsAppNumber>("whatsapp_number", ana);
    assertEquals(fixed.problem, undefined);
  });
});
