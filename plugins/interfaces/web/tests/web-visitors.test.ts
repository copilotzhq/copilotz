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
  setClientAddress,
  type Store,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { webLines } from "../lines.ts";
import { test } from "../../../../testing/mod.ts";
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

/** The visitors' line `site`, kept `days`, on this store: a runtime and the arrivals to it. */
async function lineFor(store: Store, days: number) {
  const app = definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help.", model: "fake/echo" } },
      links: LINKS,
      web: { lines: { site: { in: "shop", agent: "guide", days } } },
    },
  });
  const kept = definePlugin({
    name: "kept",
    views: {
      all: { test: (asked: { c: string }, ctx) => ctx.db.collection(asked.c).find({}).value ?? [] },
    },
  });
  const runtime = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, app, kept],
  });
  const arrive = (cookie?: string) =>
    runtime.fetch(setClientAddress(
      new Request(`${PAGE}/web/site`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PAGE,
          ...(cookie ? { cookie } : {}),
        },
        body: "{}",
      }),
      "198.51.100.20",
    ));
  const records = async (): Promise<{ _id: string; ended?: boolean; expires: string }[]> => {
    const observed = runtime.observe<{ _id: string; ended?: boolean; expires: string }[]>(
      "test",
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
  const who = (cookie: string) =>
    runtime.query<Actor | null>("contact_visitor.actor", { secret: cookie.split("=")[1] });
  return { runtime, arrive, who, records };
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
    const actor = (await before.who(cookie))!;
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
    // Its cookie is no one; arriving with it makes someone new, with a cookie of its own.
    assertEquals(await after.who(cookie), null);
    const back = await after.arrive(cookie);
    const came = await after.who(back.headers.getSetCookie()[0].split(";")[0]);
    assertNotEquals(came?.id, actor.id);
  } finally {
    Date.now = realNow;
    await open?.close();
  }
});
