/**
 * Whom a page shows Views to follows the person's own record, over the real
 * socket, as the web host keeps it (`followViewer`): renamed in this tab or
 * another, the page has the new name at once and draws again; cleared, they
 * have none, and their email stays to show them by. What `/me` answers (what
 * a page asks first) says the same.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, type Viewer } from "../../../../runtime/mod.ts";
import { type Client, connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { followViewer, session, viewerOf } from "../../session.ts";
import { listen, type Listener } from "../serve.ts";

const ana = { kind: "person", id: "ana" };

/** A browser holding `cookie`, as the page connects: a ticket from `/connect` each time. */
const browser = (server: Listener, cookie: string): Client =>
  connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${server.port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: async () => {
      const answer = await fetch(`${server.url.origin}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.url.origin, cookie },
        body: "{}",
      });
      if (answer.status !== 200) {
        await answer.body?.cancel();
        throw new Error(`no ticket: ${answer.status}`);
      }
      return (await answer.json()).ticket;
    },
    plugins: [],
  });

/** Waits until `ready` says so, or a few seconds pass. */
const until = async (ready: () => boolean, what: string, ms = 5_000) => {
  for (const end = Date.now() + ms; !ready() && Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(ready(), what);
};

test("renamed here or in another tab, the page's viewer has the new name at once; cleared, their email", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [...access] });
  const server = await listen(runtime.fetch);
  const tabs: Client[] = [];
  let stop = () => {};
  try {
    await runtime.call("person.set", { person: "ana", email: "ana@example.com", name: "Ana" });
    const cookie = `session=${
      (await runtime.call<{ session: string }>("session.start", { person: "ana" })).session
    }`;
    const me = async () =>
      await (await fetch(`${server.url.origin}/me`, { headers: { cookie } })).json();
    // This page, and another tab of hers.
    const [here, there] = [browser(server, cookie), browser(server, cookie)];
    tabs.push(here, there);
    await Promise.all([here.ready, there.ready]);
    // The page drew first with what `/me` said, then follows her record.
    session.viewer = viewerOf(ana, await me());
    const drawn: Viewer[] = [];
    stop = followViewer(here, ana, () => drawn.push(session.viewer!));
    // Its first answer is what the page knew: nothing to draw again.
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(drawn, []);

    await here.call("person.rename", { name: "  Ana   Lima " });
    await until(() => drawn.length === 1, "the page hears its own rename");
    assertEquals(drawn[0], {
      kind: "person",
      name: "ana",
      label: "Ana Lima",
      email: "ana@example.com",
    });
    assertEquals(session.viewer, drawn[0]);
    assertEquals(await me(), { person: "ana", name: "Ana Lima", email: "ana@example.com" });

    // Cleared in the other tab: no name here either, shown by her email; never her id.
    await there.call("person.rename", { name: "" });
    await until(() => drawn.length === 2, "the page hears the other tab's");
    assertEquals(drawn[1], { kind: "person", name: "ana", email: "ana@example.com" });
    assertEquals(await me(), { person: "ana", email: "ana@example.com" });
  } finally {
    stop();
    await Promise.all(tabs.map((tab) => tab.close().catch(() => {})));
    await server.shutdown();
    await runtime.close();
  }
});
