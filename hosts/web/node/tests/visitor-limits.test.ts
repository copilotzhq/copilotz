/**
 * What one web visitor can hold over the real socket, as the re-review
 * probed it: two connections, 32 reads on each, and only reads that name a
 * chat of its own, so a member's turn elsewhere runs as fast with a visitor
 * at its limits as without one. A failure's words reach a visitor only when
 * they're for anyone (never a provider's key), and an erased visitor's
 * connections end.
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
import { chat } from "../../../../plugins/agents/chat/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve, type Server } from "../mod.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An agent writing 20 chunks, 60 ms apart: each a write to `live`. */
const script: LlmAdapter = {
  async *generate() {
    for (let i = 0; i < 20; i++) {
      yield { type: "text", text: `chunk ${i} ` };
      await pause(60);
    }
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { script: { adapter: "script" }, ear: { adapter: "ear" } },
    model: { transcribe: "ear/one" },
    agents: { guide: { instructions: "x", model: "script/main" } },
    spaces: { visitors: { name: "Website", agents: ["guide"] } },
    web: {
      lines: {
        site: { in: "visitors", agent: "guide" },
        voice: { in: "visitors", agent: "guide", files: {}, transcribe: true },
      },
    },
    links: { origin: "http://127.0.0.1", secret: "the-app-secret-for-tests-0123456789" },
  },
  adapters: {
    llm: { script },
    transcription: {
      ear: {
        transcribe: () =>
          Promise.reject(
            new Error("401 Incorrect API key provided: sk-proj-Abc1****9xYz. Org org-ACME1234"),
          ),
      },
    },
  },
});

/** What a page reads, as whoever it is. */
const page = definePlugin({
  name: "page",
  views: {
    // Every live document but one: a read that names nothing, run again on every change.
    wide: {
      test: (i: number, ctx: ViewContext) =>
        (ctx.db.collection("live").find({ _id: { $ne: `x${i}` } }).value ?? []).length,
    },
    // What's being written in its own chat, but one: as narrow as a visitor's reads are.
    mine: {
      test: (asked: { thread: string; i: number }, ctx: ViewContext) =>
        (ctx.db.collection("live").find({ thread: asked.thread, _id: { $ne: `x${asked.i}` } })
          .value ?? []).length,
    },
    count: {
      test: (_: unknown, ctx: ViewContext) =>
        ctx.db.collection("live").aggregate([{ $group: { _id: null, n: { $count: {} } } }]).value,
    },
  },
});

const ana: Actor = { kind: "person", id: "ana" };

async function setup(fn: (server: Server, runtime: Runtime) => Promise<void>) {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
    transports: [socket],
    admit: tickets.admit,
  });
  const server = await serve({
    runtime,
    tickets,
    code: { entry: "app.js", files: { "app.js": "" } },
  });
  try {
    await fn(server, runtime);
  } finally {
    await server.close();
  }
}

/** `/connect` from the page, with the cookie a browser holds: a ticket, and the cookie. */
async function arrive(server: Server, cookie?: string, line = "site") {
  const r = await fetch(`${server.url.origin}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.url.origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ line }),
  });
  assertEquals(r.status, 200);
  const { ticket, actor } = await r.json() as { ticket: string; actor: Actor };
  return { ticket, actor, cookie: cookie ?? r.headers.get("set-cookie")!.split(";")[0] };
}

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

/** A member's 20-chunk turn, from asking to its answer, in ms. */
async function turn(runtime: Runtime) {
  const started = performance.now();
  const { thread } = await runtime.call<{ thread: string }>("chat.send", {
    text: "hi",
    in: "team",
    to: ["guide"],
  }, { actor: ana });
  for (let i = 0; i < 500; i++) {
    const said = await runtime.query<{ _id?: string }[]>("message.history", { thread });
    if (said.some((m) => m._id?.endsWith(":reply"))) break;
    await pause(20);
  }
  await runtime.idle();
  return performance.now() - started;
}

test("a visitor at its limits leaves a member's turn as fast: two sockets, 32 reads each, its own chat's", async () => {
  await setup(async (server, runtime) => {
    await runtime.call("space.create", { id: "team", name: "Team" }, { actor: ana });
    const alone = await turn(runtime);
    const first = await arrive(server);
    const clients: Client[] = [];
    try {
      const one = browser(server, first.ticket);
      clients.push(one);
      await one.ready;
      const { thread } = await one.call<{ thread: string }>("chat.send", { text: "hello" });
      await runtime.idle();
      // A read that names no chat of its own isn't watched; nor is an aggregate.
      await assertRejects(
        () => one.observe("test", "wide", 0).ready.then(failed),
        Error,
        "forbidden",
      );
      await assertRejects(
        () => one.observe("test", "count", 0).ready.then(failed),
        Error,
        "forbidden",
      );
      // A second socket, as the same visitor; a third is refused.
      const two = browser(server, (await arrive(server, first.cookie)).ticket);
      clients.push(two);
      await two.ready;
      const three = browser(server, (await arrive(server, first.cookie)).ticket);
      clients.push(three);
      await assertRejects(() => three.ready);
      // 32 reads on each, its own chat's; a 33rd is refused.
      let i = 0;
      for (const c of [one, two]) {
        const reads = Array.from(
          { length: 32 },
          () => c.observe("test", "mine", { thread, i: i++ }),
        );
        await Promise.all(reads.map((r) => r.ready.then(failed)));
      }
      await assertRejects(
        () => one.observe("test", "mine", { thread, i: i++ }).ready.then(failed),
        Error,
        "watches 32 reads",
      );
      const loaded = await turn(runtime);
      console.log(
        `a member's turn: ${alone.toFixed(0)} ms alone, ${loaded.toFixed(0)} ms with a visitor ` +
          `holding ${i - 1} reads on 2 sockets`,
      );
      assert(loaded < alone * 1.5 + 300, `${loaded} vs ${alone}`);
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    }
  });
});

/** An observation's first output, or its failure as an error. */
const failed = (output: { status: string; error?: unknown }) => {
  if (output.status === "failed") {
    const e = output.error as { message?: string; code?: string };
    throw new Error(`${e.code}: ${e.message}`);
  }
  return output;
};

test("a visitor is told a failure's words only when they're for anyone: never a provider's", async () => {
  await setup(async (server) => {
    const { ticket } = await arrive(server, undefined, "voice");
    const client = browser(server, ticket);
    try {
      await client.ready;
      const audio = { name: "v.ogg", type: "audio/ogg", data: btoa("\0".repeat(200)) };
      const failure = await client.call("chat.send", { files: [audio] }).catch((e) => e) as {
        message: string;
        code?: string;
      };
      console.log(`the visitor was told: ${JSON.stringify(failure.message)} (${failure.code})`);
      assertEquals(failure.code, "transcription_failed");
      assertEquals(failure.message, "Something went wrong.");
      // What's for anyone still says itself.
      const refused = await client.call("chat.send", { text: "x".repeat(4_097) })
        .catch((e) => e) as { code?: string };
      assertEquals(refused.code, "invalid");
    } finally {
      await client.close();
    }
  });
});

test("an erased visitor's connections end, and it comes back as no one", async () => {
  await setup(async (server, runtime) => {
    await runtime.call("space.create", { id: "shop", name: "Shop" }, { actor: ana });
    const came = await arrive(server);
    const client = browser(server, came.ticket);
    try {
      await client.ready;
      await client.call("chat.send", { text: "hi" });
      await runtime.idle();
      assertEquals(runtime.stats().browsers, 1);
      const [contact] = [came.actor.id];
      // The line's space is declared, so the system erases it (as its manager would).
      await runtime.call("contact.forget", { contact });
      for (let i = 0; i < 200 && runtime.stats().browsers > 0; i++) await pause(20);
      assertEquals(runtime.stats().browsers, 0);
      // A while on, still none: its ticket spent, its way back gone, it doesn't come back.
      await pause(500);
      assertEquals(runtime.stats().browsers, 0);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
