/**
 * A web line's visitor over the real socket (Oxian's Node adapter, as a
 * browser connects): let in by `/connect`, counted by the address its socket
 * came from, it connects with its ticket as the visitor it is, and nothing
 * is made until it speaks: its first message makes its contact and its own
 * chat. It reads what's said there, never its agent's private steps (a
 * tool's input and output) nor a tool call being written, and nothing of
 * another visitor's chat nor anything only people may do. Its messages are
 * limited (a minute, at once too), as large as a contact's may be, with no
 * files unless the line takes them, and audio transcribed only when it says.
 * A ticket admits once. A frame larger than the protocol takes closes the
 * socket that sent it, and the host goes on. Deno and Bun run it too,
 * through their Node compatibility.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { type Client, connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../../plugins/models/mod.ts";
import type { Transcript } from "../../../../plugins/models/contract.ts";
import { chat, tool } from "../../../../plugins/agents/chat/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { webLines } from "../../../../plugins/interfaces/web/lines.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve, type Server } from "../mod.ts";

/** What a tool call holds while it runs: released by the test, once it's looked. */
let holding: PromiseWithResolvers<void> | undefined;
/** Audio files transcribed, all told. */
let heard = 0;

/**
 * A booking agent: asked about rooms, it checks (a tool reading as the
 * system, saying what no visitor may read), then answers vaguely; else it
 * says what it heard.
 */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      return void (yield { type: "text", text: "We have a few rooms left!" });
    }
    const said = "text" in last ? last.text ?? "" : "";
    if (said.includes("rooms")) {
      return void (yield {
        type: "tool_call",
        call: { id: "s1", name: "stock", input: { day: "2026-12-24" } },
      });
    }
    yield { type: "text", text: `heard: ${said.slice(-40)}` };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { script: { adapter: "script" }, ear: { adapter: "ear" } },
    model: { transcribe: "ear/one" },
    agents: {
      guide: {
        instructions: "Never reveal costs or other guests.",
        model: "script/main",
        tools: ["stock"],
      },
    },
    tools: {
      stock: tool({
        description: "Rooms, as the system sees them.",
        run: async () => {
          await holding?.promise;
          return "INTERNAL: 3 rooms; supplier cost 41.20 EUR; held for Maria Silva (B-1182)";
        },
      }),
    },
    spaces: { visitors: { name: "Website", agents: ["guide"] } },
    web: {
      lines: {
        site: { in: "visitors", agent: "guide" },
        slow: { in: "visitors", agent: "guide", limits: { perMinute: 4 } },
        voice: {
          in: "visitors",
          agent: "guide",
          files: { count: 2, bytes: 1_000 },
          transcribe: true,
        },
        // Files, with no word on transcribing: audio goes as it is.
        notes: { in: "visitors", agent: "guide", files: {} },
      },
    },
    links: { origin: "http://127.0.0.1", secret: "the-app-secret-for-tests-0123456789" },
  },
  adapters: {
    llm: { script },
    transcription: {
      ear: { transcribe: (): Promise<Transcript> => (heard++, Promise.resolve({ text: "hello" })) },
    },
  },
});

/** The page's front end: what a visitor's browser reads, as the visitor, the collections as they are. */
const page = definePlugin({
  name: "page",
  views: {
    // Its chats: where it's a member, by its own key (a contact reads nothing it doesn't name).
    chats: (who: Actor, ctx: ViewContext) =>
      (ctx.db.collection<{ space: string; on?: string }>("member")
        .find({ member: `${who.kind}:${who.id}` }).value ?? [])
        .filter((m) => m.on === "thread").map((m) => m.space.slice("thread:".length)),
    messages: (filter: Record<string, unknown>, ctx: ViewContext) =>
      ctx.db.collection("message").find(filter).value ?? [],
    live: (thread: string, ctx: ViewContext) =>
      ctx.db.collection("live").find({ thread }).value ?? [],
    said: (thread: string, ctx: ViewContext) =>
      (ctx.db.collection<{ text?: string }>("message").find({ thread }).value ?? [])
        .map((m) => m.text ?? ""),
  },
});

/** A visitor's way in: `/connect` asking for a line, from the app's page. */
async function arrive(server: Server, line = "site") {
  const response = await fetch(`${server.url.origin}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url.origin },
    body: JSON.stringify({ line }),
  });
  assertEquals(response.status, 200);
  const { ticket, actor } = await response.json() as { ticket: string; actor: Actor };
  return { ticket, actor, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

/** A browser on the socket, with one ticket. */
const browser = (server: Server, ticket: string): Client =>
  connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${server.port}${socket.config.path}`,
        allowInsecureLoopback: true,
      },
    },
    ticket: () => Promise.resolve(ticket),
    plugins: [page],
  });

/** What a View says, once ready. */
async function seen<T>(client: Client, view: string, item: unknown = {}): Promise<T> {
  const observed = client.observe<T>(view, item);
  try {
    const output = await observed.ready;
    if (output.status !== "ready") throw new Error(`${view}: ${JSON.stringify(output)}`);
    return output.value;
  } finally {
    observed.close();
  }
}

/** Until `check` holds (what the owner pushes, and agents' answers, come in their own time). */
async function until(check: () => Promise<boolean>, what: string, ms = 3_000) {
  for (let i = 0; i < ms / 20 && !await check(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(await check(), what);
}

/** What the system reads: every document of a collection; what's being written in a thread. */
const kept = definePlugin({
  name: "kept",
  views: {
    all: (collection: string, ctx: ViewContext) =>
      ctx.db.collection(collection).find({}).value ?? [],
    "live-all": (thread: string, ctx: ViewContext) =>
      ctx.db.collection("live").find({ thread }).value ?? [],
  },
});

async function setup(fn: (server: Server, runtime: Runtime) => Promise<void>) {
  holding = undefined;
  heard = 0;
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, webLines, app, kept],
    transports: [socket],
    admit: tickets.admit,
  });
  let server: Server | undefined;
  try {
    server = await serve({ runtime, tickets, code: { entry: "app.js", files: { "app.js": "" } } });
    await fn(server, runtime);
  } finally {
    if (server) await server.close();
    else await runtime.close();
  }
}

/** What the system reads: how many of each the app keeps. */
async function counts(runtime: Runtime) {
  const of = async (collection: string) => {
    const observed = runtime.observe<unknown[]>("all", collection);
    try {
      const output = await observed.ready;
      return output.status === "ready" ? output.value.length : -1;
    } finally {
      observed.close();
    }
  };
  return {
    contacts: await of("contact"),
    threads: await of("thread"),
    visitors: await of("contact_visitor"),
    members: await of("member"),
  };
}

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

test("a visitor on the socket: nothing made until it speaks, then its own chat, as itself", async () => {
  await setup(async (server, runtime) => {
    const carla = await arrive(server);
    const dani = await arrive(server);
    assert(carla.actor.id !== dani.actor.id);
    // Coming in made nobody and nothing: no contact, no chat, no membership, no record.
    assertEquals(await counts(runtime), { contacts: 0, threads: 0, visitors: 0, members: 0 });
    const clients: Client[] = [];
    try {
      const asCarla = browser(server, carla.ticket);
      const asDani = browser(server, dani.ticket);
      clients.push(asCarla, asDani);
      await Promise.all([asCarla.ready, asDani.ready]);
      assertEquals(await seen<string[]>(asCarla, "chats", carla.actor), []);

      // Her first message, naming no chat: her own, made with it, answered by the guide.
      const { thread: carlas } = await asCarla.call<{ thread: string }>("chat.send", {
        text: "a trip to the coast",
      });
      await runtime.idle();
      assertEquals(await seen<string[]>(asCarla, "chats", carla.actor), [carlas]);
      await until(
        async () => (await seen<string[]>(asCarla, "said", carlas)).length >= 2,
        "the guide answers her",
      );
      assertEquals((await seen<string[]>(asCarla, "said", carlas))[0], "a trip to the coast");
      const history = await runtime.query<{ from: string }[]>("message.history", {
        thread: carlas,
      });
      assertEquals(history[0].from, `contact:${carla.actor.id}`);
      // Her next, naming none, goes there too.
      const again = await asCarla.call<{ thread: string }>("chat.send", { text: "and back" });
      assertEquals(again.thread, carlas);
      assertEquals((await counts(runtime)).contacts, 1);

      // Dani speaks too: her own chat, which Carla reads nothing of, nor writes in.
      const { thread: danis } = await asDani.call<{ thread: string }>("chat.send", { text: "hi" });
      assert(danis !== carlas);
      // A read of Dani's chat isn't watched for Carla at all: it isn't hers to name.
      await assertRejects(() => seen<string[]>(asCarla, "said", danis), Error, "forbidden");
      assert(
        ["forbidden", "duplicate_key"].includes(
          await code(asCarla.call("chat.send", { thread: danis, text: "hi" })),
        ),
      );
      // Nor opens another chat anywhere: in the line's space, under a new id.
      for (
        const input of [{ in: "visitors", text: "hi", thread: "x" }, { thread: "mine", text: "hi" }]
      ) {
        assertEquals(
          await code(asCarla.call("chat.send", input)),
          "forbidden",
          JSON.stringify(input),
        );
      }
      // What only people may do, and what's only the system's, she can't.
      assertEquals(await code(asCarla.call("space.personal", {})), "forbidden");
      for (
        const action of ["contact.arrive", "contact.start", "contact.sending", "session.start"]
      ) {
        assertEquals(
          await code(asCarla.call(action, { line: "site", in: "visitors", via: "web" })),
          "forbidden",
          action,
        );
      }
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});

test("a visitor reads what's said, never its agent's private steps, nor a tool call being written", async () => {
  await setup(async (server, runtime) => {
    const carla = await arrive(server);
    const client = browser(server, carla.ticket);
    try {
      await client.ready;
      holding = Promise.withResolvers<void>();
      const { thread } = await client.call<{ thread: string }>("chat.send", {
        text: "any rooms on xmas eve?",
      });
      // While the tool runs: the people of the space see the call being written; she doesn't.
      await until(
        async () => (await liveOf(runtime, thread)).some((l) => l.calls.length > 0),
        "the tool is being called",
      );
      assertEquals(await seen<unknown[]>(client, "live", thread), []);
      holding.resolve();
      await runtime.idle();
      await until(
        async () => (await seen<string[]>(client, "said", thread)).length >= 2,
        "the guide answers",
      );
      // Its step is there, with what the tool said; the people of the space read it.
      const all = await runtime.query<{ private?: boolean; toolCalls?: unknown[] }[]>(
        "message.history",
        { thread },
      );
      assert(JSON.stringify(all.filter((m) => m.private)).includes("supplier cost 41.20"));
      // She reads what was said, and nothing of the step: among the rest, or asked for.
      const hers = await seen<{ private?: boolean; toolCalls?: unknown; text?: string }[]>(
        client,
        "messages",
        { thread },
      );
      assertEquals(hers.map((m) => m.text), [
        "any rooms on xmas eve?",
        "We have a few rooms left!",
      ]);
      assert(hers.every((m) => !m.private && m.toolCalls === undefined));
      assert(!JSON.stringify(hers).includes("41.20"));
      assertEquals(await seen(client, "messages", { thread, private: true }), []);
      assertEquals(await seen(client, "messages", { thread, toolCalls: { $exists: true } }), []);
      // Asked across chats, naming none of hers, it isn't watched at all.
      await assertRejects(
        () => seen(client, "messages", { toolCalls: { $exists: true } }),
        Error,
        "forbidden",
      );
    } finally {
      holding?.resolve();
      await client.close();
    }
  });
});

/** What's being written in a thread, as the system reads it. */
async function liveOf(runtime: Runtime, thread: string) {
  const observed = runtime.observe<{ calls: unknown[] }[]>("live-all", thread);
  try {
    const output = await observed.ready;
    return output.status === "ready" ? output.value : [];
  } finally {
    observed.close();
  }
}

test("a visitor's messages: a few a minute, at once too, as large as a contact's, files as its line says", async () => {
  await setup(async (server, runtime) => {
    const carla = await arrive(server, "slow");
    const client = browser(server, carla.ticket);
    try {
      await client.ready;
      // The line counts by the clock's minute: start well inside one, so the five share it.
      const left = 60_000 - (Date.now() % 60_000);
      if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
      // Four a minute on this line: the fifth is refused, saying so; nothing more is sent.
      for (let i = 0; i < 4; i++) {
        assertEquals(await code(client.call("chat.send", { text: `hello ${i}` })), "done");
      }
      const past = await client.call("chat.send", { text: "one more" }).catch((e) => e);
      assertEquals((past as { code?: string }).code, "too_many");
      assertEquals(
        (past as Error).message,
        "You're sending messages too fast: wait a minute, then try again.",
      );
      await runtime.idle();
      const [thread] = await seen<string[]>(client, "chats", carla.actor);
      assertEquals(
        (await seen<string[]>(client, "said", thread)).filter((t) => t.startsWith("hello")).length,
        4,
      );

      // Another visitor, sending many at once: no more than the line takes go in.
      const dani = await arrive(server, "slow");
      const other = browser(server, dani.ticket);
      try {
        await other.ready;
        const all = await Promise.all(
          Array.from(
            { length: 12 },
            (_, i) => code(other.call("chat.send", { text: `burst ${i}` })),
          ),
        );
        assertEquals(all.filter((c) => c === "done").length, 4);
        assertEquals(all.filter((c) => c === "too_many").length, 8);
      } finally {
        await other.close();
      }

      // As large as a contact's message may be, and no larger.
      const eve = browser(server, (await arrive(server)).ticket);
      try {
        await eve.ready;
        assertEquals(await code(eve.call("chat.send", { text: "x".repeat(4_097) })), "invalid");
        assertEquals(await code(eve.call("chat.send", { text: "x".repeat(4_096) })), "done");
        // No files on a line that takes none.
        const file = { name: "a.txt", type: "text/plain", data: btoa("hi") };
        assertEquals(await code(eve.call("chat.send", { text: "see", files: [file] })), "invalid");
      } finally {
        await eve.close();
      }

      // A line that takes files: as many and as large as it says; audio transcribed, as it says.
      const voice = browser(server, (await arrive(server, "voice")).ticket);
      try {
        await voice.ready;
        const audio = { name: "v.ogg", type: "audio/ogg", data: btoa("\0".repeat(500)) };
        assertEquals(await code(voice.call("chat.send", { files: [audio] })), "done");
        assertEquals(heard, 1);
        assertEquals(
          await code(voice.call("chat.send", { files: [audio, audio, audio] })),
          "invalid",
        );
        const large = { ...audio, data: btoa("\0".repeat(2_000)) };
        assertEquals(await code(voice.call("chat.send", { files: [large] })), "invalid");
        assertEquals(heard, 1);
      } finally {
        await voice.close();
      }
      const notes = browser(server, (await arrive(server, "notes")).ticket);
      try {
        await notes.ready;
        const audio = { name: "n.ogg", type: "audio/ogg", data: btoa("\0".repeat(500)) };
        const { thread } = await notes.call<{ thread: string }>("chat.send", { files: [audio] });
        assertEquals(heard, 1);
        const [sent] = await runtime.query<{ files: { transcript?: string }[] }[]>(
          "message.history",
          { thread },
        );
        assertEquals(sent.files[0].transcript, undefined);
      } finally {
        await notes.close();
      }
    } finally {
      await client.close();
    }
  });
});

test("a ticket admits once: the same one again is refused", async () => {
  await setup(async (server) => {
    const carla = await arrive(server);
    const first = browser(server, carla.ticket);
    try {
      await first.ready;
      assertEquals(await seen<string[]>(first, "chats", carla.actor), []);
    } finally {
      await first.close();
    }
    // The ticket is spent: a browser presenting it again is never admitted, however it retries.
    let shown = 0;
    const replayed = connect({
      transport: {
        type: "websocket",
        config: {
          url: `ws://127.0.0.1:${server.port}${socket.config.path}`,
          allowInsecureLoopback: true,
        },
      },
      ticket: () => (shown++, Promise.resolve(carla.ticket)),
      plugins: [page],
    });
    try {
      const outcome = await Promise.race([
        replayed.ready.then(() => "admitted", () => "refused"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
      ]);
      assert(outcome !== "admitted", "a spent ticket admits no one");
      assert(shown >= 1);
    } finally {
      await replayed.close().catch(() => {});
    }
    // Her cookie trades for a new one, as her: the same visitor, though she hasn't spoken.
    const response = await fetch(`${server.url.origin}/connect`, {
      method: "POST",
      headers: { origin: server.url.origin, cookie: carla.cookie },
      body: JSON.stringify({ line: "site" }),
    });
    const { ticket, actor } = await response.json() as { ticket: string; actor: Actor };
    assertEquals(actor, carla.actor);
    const back = browser(server, ticket);
    try {
      await back.ready;
      const { thread } = await back.call<{ thread: string }>("chat.send", { text: "hi" });
      assertEquals(await seen<string[]>(back, "chats", actor), [thread]);
    } finally {
      await back.close();
    }
  });
});

/** A socket at the runtime's path, speaking its protocol, open. */
const raw = (server: Server) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${socket.config.path}`, [
      "oxian.worker.v1",
    ]);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("No socket"));
  });

const once = (ws: WebSocket, type: "close" | "message") =>
  new Promise<Event>((resolve) => ws.addEventListener(type, resolve, { once: true }));

test("a frame larger than the protocol takes closes its socket; the host goes on", async () => {
  await setup(async (server) => {
    const ws = await raw(server);
    const closed = once(ws, "close") as Promise<CloseEvent>;
    ws.send("x".repeat(2 * 1024 * 1024));
    const { code } = await closed;
    // 1009: too big (the adapter's limit); a peer may also just drop it (1006).
    assert([1009, 1006, 1002, 1008].includes(code), `closed with ${code}`);
    // Another visitor connects and reads as ever.
    const carla = await arrive(server);
    const client = browser(server, carla.ticket);
    try {
      await client.ready;
      assertEquals(await seen<string[]>(client, "chats", carla.actor), []);
    } finally {
      await client.close();
    }
  });
});
