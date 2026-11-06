/**
 * A web visitor's secret over time: one made later than now (past a few
 * minutes of clocks' skew) is nobody's, and an erased visitor stays erased
 * for as long as any cookie made before could last, even once its line's
 * days are raised (a cookie lasts as its line says now).
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  type Store,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { webLines } from "../lines.ts";
import { test } from "../../../../testing/mod.ts";
import { createTickets } from "../../../../hosts/web/tickets.ts";
import { setClientAddress, webServer } from "../../../../hosts/web/server.ts";
import { newSecret, visitOf } from "../shared/secret.ts";

const PAGE = "https://book.example.com";
const LINKS = { origin: PAGE, secret: "the-app-secret-for-web-visitors-0123456789" };
const ana: Actor = { kind: "person", id: "ana" };
const DAY = 86_400_000;

/** Time as the test sets it, back to the machine's after. */
const realNow = Date.now;
const at = (ms: number) => {
  const shift = ms - realNow();
  Date.now = () => realNow() + shift;
};

test("a visitor's secret made later than now is nobody's; within a few minutes' skew, it's good", async () => {
  const ring = { secrets: [LINKS.secret] };
  try {
    at(realNow() + 10 * 60_000);
    const ahead = await newSecret(ring, "site", []);
    at(realNow() + 2 * 60_000);
    const skewed = await newSecret(ring, "site", []);
    Date.now = realNow;
    assertEquals(await visitOf(ring, ahead), undefined);
    assertEquals((await visitOf(ring, skewed))?.line, "site");
    // Its making is what it's signed with: changing it to now breaks it.
    const now = Date.now().toString(36);
    const parts = ahead.split(".");
    assertEquals(
      await visitOf(ring, [...parts.slice(0, 2), now, ...parts.slice(3)].join(".")),
      undefined,
    );
  } finally {
    Date.now = realNow;
  }
});

/** The visitors' line `site`, kept `days`, on this store: a runtime and its web host. */
async function lineFor(store: Store, days: number) {
  const tickets = createTickets({ perMinute: 100_000 });
  const app = definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help.", model: "fake/echo" } },
      links: LINKS,
      web: { site: { in: "shop", agent: "guide", days } },
    },
  });
  const kept = definePlugin({
    name: "kept",
    views: {
      all: (asked: { c: string }, ctx) => ctx.db.collection(asked.c).find({}).value ?? [],
    },
  });
  const runtime = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, app, kept],
  });
  const serve = webServer({ runtime, tickets, code: { entry: "app.js", files: { "app.js": "" } } });
  const arrive = (cookie?: string) =>
    serve(setClientAddress(
      new Request(`${PAGE}/connect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PAGE,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ line: "site" }),
      }),
      "198.51.100.20",
    ));
  const records = async (): Promise<{ _id: string; ended?: boolean; expires: string }[]> => {
    const observed = runtime.observe<{ _id: string; ended?: boolean; expires: string }[]>(
      "all",
      { c: "contact_visitor" },
    );
    try {
      const output = await observed.ready;
      return output.status === "ready" ? output.value : [];
    } finally {
      observed.close();
    }
  };
  return { runtime, tickets, arrive, records };
}

test("an erased visitor stays no one past its record's first time, once its line's days are raised", async () => {
  const store = memoryStore();
  /** The runtime open now, closed once, whatever happens. */
  let open: Runtime | undefined;
  try {
    // A line keeping visitors 30 days: one speaks, and is erased.
    const before = await lineFor(store, 30);
    open = before.runtime;
    await before.runtime.call("space.create", { id: "shop", name: "Shop" }, { actor: ana });
    const first = await before.arrive();
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    const actor = before.tickets.admit((await first.json()).ticket)!;
    await before.runtime.call("chat.send", { text: "hello" }, { actor });
    await before.runtime.idle();
    await before.runtime.call("contact.forget", { contact: actor.id, chats: true }, { actor: ana });
    open = undefined;
    await before.runtime.close();
    // The line now keeps visitors 90 days: the cookie is good that long, as far as its line says.
    const after = await lineFor(store, 90);
    open = after.runtime;
    at(realNow() + 45 * DAY);
    await after.runtime.call("contact.prune", {});
    const [record] = await after.records();
    assertEquals([record?._id, record?.ended], [actor.id, true]);
    const back = await after.arrive(cookie);
    const { actor: came } = await back.json();
    assertNotEquals(came.id, actor.id);
    assertEquals(
      await after.runtime.query("contact_visitor.actor", { secret: cookie.split("=")[1] }),
      null,
    );
  } finally {
    Date.now = realNow;
    await open?.close();
  }
});
