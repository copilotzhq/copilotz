/**
 * A web line's visitor over the real socket (Oxian's Node adapter, as a
 * browser connects): let in by `/connect`, it connects with its ticket as
 * the contact it is, says something in its own chat, reads it, and reaches
 * nothing of another visitor's chat nor anything only people may do. A
 * ticket admits once. A frame larger than the protocol takes closes the
 * socket that sent it, and the host goes on. Deno and Bun run it too,
 * through their Node compatibility.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { type Client, connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../../plugins/models/mod.ts";
import { chat } from "../../../../plugins/agents/chat/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve, type Server } from "../mod.ts";

/** An app with one web line, `site`, in a space it declares, answered by its guide. */
const app = definePlugin({
  name: "app",
  resources: {
    agents: { guide: { instructions: "Help visitors.", model: "fake/echo" } },
    spaces: { visitors: { name: "Website", agents: ["guide"] } },
    web: { lines: { site: { in: "visitors", agent: "guide" } } },
  },
});

/** The page's front end: what a visitor's browser reads, as the visitor. */
const page = definePlugin({
  name: "page",
  views: {
    chats: {
      test: (_: unknown, ctx: ViewContext) =>
        (ctx.db.collection<{ _id: string }>("thread").find({}).value ?? []).map((t) => t._id),
    },
    said: {
      test: (thread: string, ctx: ViewContext) =>
        (ctx.db.collection<{ from: string; text?: string; private?: boolean }>("message")
          .find({ thread }).value ?? []).filter((m) => !m.private).map((m) => m.text ?? ""),
    },
  },
});

/** A visitor's way in: `/connect` asking for the line, from the app's page. */
async function arrive(server: Server) {
  const response = await fetch(`${server.url.origin}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url.origin },
    body: JSON.stringify({ line: "site" }),
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
  const observed = client.observe<T>("test", view, item);
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

async function setup(fn: (server: Server, runtime: Runtime) => Promise<void>) {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
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

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

test("a visitor on the socket: its own chat, as itself; nothing of another's, nor of people's", async () => {
  await setup(async (server, runtime) => {
    const carla = await arrive(server);
    const dani = await arrive(server);
    assert(carla.actor.id !== dani.actor.id);
    const clients: Client[] = [];
    try {
      const asCarla = browser(server, carla.ticket);
      const asDani = browser(server, dani.ticket);
      clients.push(asCarla, asDani);
      await Promise.all([asCarla.ready, asDani.ready]);

      // Each reads exactly one chat: its own.
      const [carlas] = await seen<string[]>(asCarla, "chats");
      const [danis] = await seen<string[]>(asDani, "chats");
      assertEquals((await seen<string[]>(asCarla, "chats")).length, 1);
      assert(carlas && danis && carlas !== danis);

      // Carla says something in hers, as herself; the guide answers there.
      await asCarla.call("chat.send", { thread: carlas, text: "a trip to the coast" });
      await runtime.idle();
      await until(
        async () => (await seen<string[]>(asCarla, "said", carlas)).length >= 2,
        "the guide answers her",
      );
      const hers = await seen<string[]>(asCarla, "said", carlas);
      assertEquals(hers[0], "a trip to the coast");
      const history = await runtime.query<{ from: string; text?: string }[]>(
        "message.history",
        { thread: carlas },
      );
      assertEquals(history[0].from, `contact:${carla.actor.id}`);

      // Dani's chat: she reads nothing of it, and can't write there.
      assertEquals(await seen<string[]>(asCarla, "said", danis), []);
      assert(
        ["forbidden", "duplicate_key"].includes(
          await code(asCarla.call("chat.send", { thread: danis, text: "hi" })),
        ),
      );
      // Nor open another chat anywhere: in the line's space, in none, under a new id.
      for (
        const input of [
          { in: "visitors", text: "hi" },
          { text: "hi" },
          { thread: "a-chat-of-my-own", text: "hi" },
        ]
      ) {
        assertEquals(
          await code(asCarla.call("chat.send", input)),
          "forbidden",
          JSON.stringify(input),
        );
      }
      assertEquals(
        (await runtime.query<unknown[]>("message.history", { thread: danis })).length,
        0,
      );
      // What only people may do, and what's only the system's, she can't.
      assertEquals(await code(asCarla.call("space.personal", {})), "forbidden");
      for (const action of ["contact.arrive", "contact.start", "session.start"]) {
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

test("a ticket admits once: the same one again is refused", async () => {
  await setup(async (server) => {
    const carla = await arrive(server);
    const first = browser(server, carla.ticket);
    try {
      await first.ready;
      assertEquals((await seen<string[]>(first, "chats")).length, 1);
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
    // Her cookie trades for a new one, as her.
    const response = await fetch(`${server.url.origin}/connect`, {
      method: "POST",
      headers: { origin: server.url.origin, cookie: carla.cookie },
    });
    const { ticket, actor } = await response.json() as { ticket: string; actor: Actor };
    assertEquals(actor, carla.actor);
    const back = browser(server, ticket);
    try {
      await back.ready;
      assertEquals((await seen<string[]>(back, "chats")).length, 1);
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
      assertEquals((await seen<string[]>(client, "chats")).length, 1);
    } finally {
      await client.close();
    }
  });
});
