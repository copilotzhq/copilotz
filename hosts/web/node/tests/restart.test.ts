/**
 * A page that loads as the server restarts, over the real socket: it asked
 * the old process for its ticket, and comes in to the new one, which never
 * issued it. The ticket is refused, so the page's client asks `/connect` for
 * a new one and comes in, as a reload would have. Asking stops after 3
 * tickets refused, and at once when asking fails otherwise (the browser
 * signed out: no ticket at all).
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime } from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { identity } from "../../../../plugins/access/identity/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { serve } from "../serve.ts";

/** A page's POST, from its own origin, with a session's cookie. */
const post = (origin: string, path: string, cookie: string) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: "{}",
  });

/**
 * A page at `port`, holding `cookie`: its first connection takes the ticket in
 * `first` (the one the page asked for as it loaded), and each one after asks
 * `/connect`, as the web host does; what each asking answered is kept.
 */
const page = (port: number, cookie: string, first?: string) => {
  const asked: number[] = [];
  const origin = `http://127.0.0.1:${port}`;
  const client = connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: async () => {
      const kept = first;
      first = undefined;
      if (kept) return kept;
      const answer = await post(origin, "/connect", cookie);
      asked.push(answer.status);
      if (!answer.ok) {
        await answer.body?.cancel();
        throw new Error(`no ticket: ${answer.status}`);
      }
      return (await answer.json()).ticket;
    },
    plugins: [],
  });
  return { client, asked };
};

/** Ana's app served on a port, and served again on the same one, on the same store. */
async function restarting() {
  const store = memoryStore();
  const open = () => createRuntime({ store, plugins: [identity] });
  let served = await serve(open);
  const port = served.server.port;
  const origin = `http://127.0.0.1:${port}`;
  const { session } = await served.app.call<{ session: string }>("session.start", {
    person: "ana",
  });
  const cookie = `session=${session}`;
  return {
    port,
    cookie,
    /** A ticket from the process serving now. */
    ticket: async () => (await (await post(origin, "/connect", cookie)).json()).ticket as string,
    restart: async () => {
      await served.stop();
      served = await serve(open, { port });
    },
    stop: () => served.stop(),
  };
}

test("a page that asked for its ticket before a restart asks for another, and comes in", async () => {
  const app = await restarting();
  const old = await app.ticket();
  await app.restart();
  const { client, asked } = page(app.port, app.cookie, old);
  try {
    await client.ready;
    // The old ticket was refused; one more asked for, from the process serving now.
    assertEquals(asked, [200]);
  } finally {
    await client.close().catch(() => {});
    await app.stop();
  }
});

test("a page whose every ticket is refused stops after 3, and says why", async () => {
  const app = await restarting();
  const asked: number[] = [];
  const client = connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${app.port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: () => {
      asked.push(asked.length);
      return Promise.resolve("a-ticket-nobody-issued");
    },
    plugins: [],
  });
  try {
    const error = await assertRejects(() => client.ready);
    assertStringIncludes((error as Error).message, "re-enrollment");
    assertEquals(asked.length, 3);
  } finally {
    await client.close().catch(() => {});
    await app.stop();
  }
});

test("a page with no ticket to ask for (signed out) stays out at once", async () => {
  const app = await restarting();
  const old = await app.ticket();
  await app.restart();
  const { client, asked } = page(app.port, "session=gone", old);
  try {
    await assertRejects(() => client.ready, Error, "no ticket: 401");
    assertEquals(asked, [401]);
  } finally {
    await client.close().catch(() => {});
    await app.stop();
  }
});
