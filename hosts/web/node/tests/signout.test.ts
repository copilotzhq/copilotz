/**
 * Signing out ends the browsers connected as whoever signed out, over the
 * real socket: each of their connections is let go and their resume
 * credentials with it, so a browser comes back only with a new ticket, which
 * only a cookie that's still someone gets: the one that signed out can't
 * (its session ended, its cookie cleared).
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, defineAction, definePlugin, people } from "../../../../runtime/mod.ts";
import { type Client, connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { identity } from "../../../../plugins/access/identity/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve, type Server } from "../mod.ts";

/** Who a browser is, as the runtime sees it when it calls. */
const who = definePlugin({
  name: "who",
  actions: {
    "who.am": defineAction({
      input: { type: "object" },
      allow: people,
      run: (ctx) => ctx.actor?.id,
    }),
  },
});

/** A page's POST, from its own origin, with a session's cookie. */
const post = (server: Server, path: string, cookie: string) =>
  fetch(`${server.url.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url.origin, cookie },
    body: "{}",
  });

/**
 * A browser holding `cookie`: each new connection asks `/connect` for a
 * ticket, as the page does; what each asking answered is kept.
 */
const browser = (server: Server, cookie: string) => {
  const asked: number[] = [];
  const client: Client = connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${server.port}${socket.config.path}`,
        allowInsecureLoopback: true,
      },
    },
    ticket: async () => {
      const answer = await post(server, "/connect", cookie);
      asked.push(answer.status);
      if (answer.status !== 200) {
        await answer.body?.cancel();
        throw new Error(`no ticket: ${answer.status}`);
      }
      return (await answer.json()).ticket;
    },
    plugins: [],
  });
  return { client, asked };
};

/** Waits until `ready` says so, or a few seconds pass. */
const until = async (ready: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; !ready() && Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return ready();
};

/** Ana's runtime on a real socket, with two sessions of hers: a laptop's and a phone's. */
async function twoDevices() {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [identity, who],
    transports: [socket],
    admit: tickets.admit,
  });
  const server = await serve({
    runtime,
    tickets,
    code: { entry: "app.js", files: { "app.js": "" } },
  });
  const start = async () =>
    (await runtime.call<{ session: string }>("session.start", { person: "ana" })).session;
  const [laptop, phone] = [await start(), await start()];
  const a = browser(server, `session=${laptop}`);
  const b = browser(server, `session=${phone}`);
  const close = async () => {
    await Promise.all([a.client, b.client].map((c) => c.close().catch(() => {})));
    await server.close();
  };
  try {
    await Promise.all([a.client.ready, b.client.ready]);
    assertEquals(await a.client.call("who.am", {}), "ana");
    assertEquals(await b.client.call("who.am", {}), "ana");
    assertEquals(runtime.stats().browsers, 2);
  } catch (error) {
    await close();
    throw error;
  }
  const signOut = async () => {
    const out = await post(server, "/signout", `session=${laptop}`);
    await out.body?.cancel();
    assertEquals(out.status, 200);
  };
  return { runtime, a, b, signOut, close };
}

test("signing out ends the browser that signed out: it never comes back on its old credentials, nor with a ticket", async () => {
  const { runtime, a, signOut, close } = await twoDevices();
  try {
    await signOut();
    // Its connection ends; asking to come in again, its cookie is no one (401), so it stays out.
    const out = await until(() => a.asked.length > 1);
    // A while on, still out: no connection came back on a resume credential it held.
    await new Promise((r) => setTimeout(r, 1_000));
    console.log(
      `after signing out on the laptop: browsers connected ${runtime.stats().browsers}; ` +
        `the laptop asked /connect ${JSON.stringify(a.asked)}`,
    );
    assert(out, "the laptop's connection ended");
    assertEquals(a.asked[0], 200);
    assert(a.asked.slice(1).every((status) => status === 401));
    assertEquals(runtime.stats().browsers, 1);
  } finally {
    await close();
  }
});

/**
 * What signing out leaves of the same person's other devices: each comes
 * back with a new ticket (its resume credential refused, the client comes
 * in again), its own session still good.
 */
test({
  name: "signing out on one device: another of the same person's comes back with a new ticket",
  fn: async () => {
    const { runtime, a, b, signOut, close } = await twoDevices();
    try {
      await signOut();
      const back = await until(() => b.asked.length > 1 && runtime.stats().browsers === 1);
      console.log(
        `after signing out on the laptop: laptop asked /connect ${JSON.stringify(a.asked)}, ` +
          `phone ${JSON.stringify(b.asked)}; browsers connected: ${runtime.stats().browsers}`,
      );
      assert(back, "the phone came back, and only it");
      assertEquals(b.asked.at(-1), 200);
      assert(a.asked.slice(1).every((status) => status === 401));
      assertEquals(await b.client.call("who.am", {}), "ana");
    } finally {
      await close();
    }
  },
});
