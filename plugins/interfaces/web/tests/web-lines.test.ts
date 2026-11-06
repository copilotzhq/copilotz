/**
 * A web line under load, as the re-review probed it: arrivals keep nothing
 * per arrival (a visitor's tags ride on the visitor the server issues), and
 * IPv6 is counted by its /56 and /48 too, so one routed /48 is no longer
 * 65,536 callers. The line's own limits are no off switch: a few networks
 * can't fill them (their networks' limits stop them first), visitors who
 * spoke before keep a share of the line's minute, and a newcomer still
 * speaks after hundreds have come. A line may have a budget (what its
 * visitors' turns cost a day, as the usage ledger prices them) and a
 * challenge (an Action of the app's, a CAPTCHA's check). An erased visitor
 * stays erased, pruned or not.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import usage from "../../../billing/usage/mod.ts";
import { access } from "../../../access/mod.ts";
import { webLines } from "../lines.ts";
import { test } from "../../../../testing/mod.ts";
import { createTickets, type Tickets } from "../../../../hosts/web/tickets.ts";
import { setClientAddress, webServer } from "../../../../hosts/web/server.ts";

const PAGE = "https://book.example.com";
const LINKS = { origin: PAGE, secret: "the-app-secret-for-web-lines-0123456789" };
const ana: Actor = { kind: "person", id: "ana" };

/** Every document of a collection, as the system reads it. */
const kept = definePlugin({
  name: "kept",
  views: {
    all: (asked: { c: string }, ctx) => ctx.db.collection(asked.c).find({}).value ?? [],
  },
});

async function all<T = Record<string, unknown>>(runtime: Runtime, c: string): Promise<T[]> {
  const observed = runtime.observe<T[]>("all", { c });
  try {
    const output = await observed.ready;
    if (output.status !== "ready") throw new Error(JSON.stringify(output));
    return output.value;
  } finally {
    observed.close();
  }
}

/** Time as the test sets it: windows begin where it says. */
const realNow = Date.now;
let shift = 0;
const at = (ms: number) => {
  shift = ms - realNow();
  Date.now = () => realNow() + shift;
};

type Line = Record<string, unknown>;

async function setup(
  fn: (s: {
    runtime: Runtime;
    tickets: Tickets;
    visitor(address: string, more?: Record<string, unknown>, cookie?: string): Promise<Actor>;
    arrive(address: string, more?: Record<string, unknown>, cookie?: string): Promise<Response>;
    send(actor: Actor, text: string): Promise<string>;
  }) => Promise<void>,
  options: { line?: Line; plugins?: Plugin[]; resources?: Record<string, unknown> } = {},
) {
  const tickets = createTickets({ perMinute: 100_000 });
  const app = definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help.", model: "fake/echo" } },
      spaces: { visitors: { name: "Website", agents: ["guide"] } },
      links: LINKS,
      web: { site: { in: "visitors", agent: "guide", ...options.line } },
      ...options.resources,
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, webLines, app, kept, ...options.plugins ?? []],
  });
  try {
    const serve = webServer({
      runtime,
      tickets,
      code: { entry: "app.js", files: { "app.js": "" } },
    });
    const arrive = (address: string, more: Record<string, unknown> = {}, cookie?: string) =>
      serve(setClientAddress(
        new Request(`${PAGE}/connect`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: PAGE,
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({ line: "site", ...more }),
        }),
        address,
      ));
    const visitor = async (address: string, more?: Record<string, unknown>, cookie?: string) => {
      const r = await arrive(address, more, cookie);
      if (r.status !== 200) throw new Error(`connect ${r.status} ${await r.text()}`);
      return tickets.admit((await r.json()).ticket)!;
    };
    const send = (actor: Actor, text: string) =>
      runtime.call("chat.send", { text }, { actor }).then(
        () => "done",
        (e: { code?: string; message: string }) => `${e.code}: ${e.message}`,
      );
    await fn({ runtime, tickets, visitor, arrive, send });
    await runtime.idle();
  } finally {
    Date.now = realNow;
    await runtime.close();
  }
}

const BUSY = "too_many: This chat is busy right now: try again in a few minutes.";

test("an arrival keeps nothing of its own: only counters by network, for their hour", async () => {
  await setup(async ({ runtime, arrive, visitor, send }) => {
    // 21 from one /64, in each of three /48s: 20 let in from each, the 21st refused.
    let ok = 0;
    for (const net of ["2001:db8:a", "2001:db8:b", "2001:db8:c"]) {
      for (let i = 1; i <= 21; i++) {
        const r = await arrive(`${net}::${i}`);
        if (r.status === 200) ok++;
        await r.body?.cancel();
      }
    }
    assertEquals(ok, 60);
    // In memory: a counter for each network an hour (the /64, its /56, its /48), nothing per
    // arrival, and nothing kept past its hour.
    const rates = await all<{ _id: string; until: number }>(runtime, "contact_rate");
    assertEquals(rates.length, 9);
    assert(rates.every((r) => r._id.includes("|ip|") && r.until - Date.now() <= 3_600_000));
    // What its messages are counted by rides on the visitor the server issued: they still are.
    const carla = await visitor("2001:db8:d::1");
    assertEquals((carla.from as string[]).map((t) => t.split("-")[0]), ["64", "56", "48"]);
    assertEquals(await send(carla, "hi"), "done");
    assertEquals((await all(runtime, "contact_visitor")).length, 1);
  });
});

test("IPv6 by its /56 and /48 too: one routed /48 is no longer 65,536 callers", async () => {
  await setup(async ({ arrive }) => {
    const lets = async (froms: string[]) => {
      let ok = 0;
      for (const from of froms) {
        const r = await arrive(from);
        if (r.status === 200) ok++;
        await r.body?.cancel();
      }
      return ok;
    };
    // 50 /64s of one /56, 21 tries each (the probe's): the /56 lets in 4 x 20.
    const oneNet = Array.from(
      { length: 50 },
      (_, n) => Array.from({ length: 21 }, (_, i) => `2001:db8:0:${n.toString(16)}::${i + 1}`),
    ).flat();
    assertEquals(await lets(oneNet), 80);
    // 40 /56s of one /48, 5 each: the /48 lets in 8 x 20.
    const oneSite = Array.from(
      { length: 40 },
      (_, n) =>
        Array.from({ length: 5 }, (_, i) => `2001:db8:1:${(n * 0x100).toString(16)}::${i + 1}`),
    )
      .flat();
    assertEquals(await lets(oneSite), 160);
    // Elsewhere, anyone still comes in.
    assertEquals(await lets(["2001:db8:2::1", "198.51.100.1"]), 2);
  });
});

test("a line's minute can't be filled from a few networks: someone who spoke before still speaks", async () => {
  // Just after a minute begins, so the burst stays in one window.
  at(Math.ceil(realNow() / 60_000) * 60_000 + 1_000);
  await setup(async ({ visitor, send }) => {
    const legit = await visitor("198.51.100.7");
    assertEquals(await send(legit, "hello, a room for two?"), "done");
    shift += 60_000;
    // The probe's attack: 10 /64s (of one /56), 3 visitors each, 10 messages each.
    let sent = 0;
    for (let n = 0; n < 10; n++) {
      for (let v = 0; v < 3; v++) {
        const a = await visitor(`2001:db8:7:${n.toString(16)}::${v + 1}`);
        for (let m = 0; m < 10; m++) if ((await send(a, `spam ${m}`)) === "done") sent++;
      }
    }
    // Their /56 takes 4 x 30 a minute, far from the line's 300: everyone else goes on.
    assertEquals(sent, 120);
    assertEquals(await send(legit, "are you there?"), "done");
  });
});

test("newcomers from everywhere fill only their share of the line's minute: the rest is kept for those who spoke", async () => {
  at(Math.ceil(realNow() / 60_000) * 60_000 + 1_000);
  await setup(async ({ visitor, send }) => {
    const legit = await visitor("198.51.100.7");
    assertEquals(await send(legit, "hello"), "done");
    shift += 60_000;
    // From as many /48s as it takes, newcomers send all they may: 200 of the line's 300 go in.
    let sent = 0;
    for (let n = 0; n < 30; n++) {
      const a = await visitor(`2001:db8:${(0x100 + n).toString(16)}::1`);
      for (let m = 0; m < 10; m++) if ((await send(a, `spam ${m}`)) === "done") sent++;
    }
    assertEquals(sent, 200);
    // A visitor who spoke before the minute isn't a newcomer: what's kept is theirs.
    assertEquals(await send(legit, "still there?"), "done");
  }, { line: { limits: { ipPerMinute: 1_000 } } });
});

test("hundreds of new speakers from a few networks don't stop a newcomer speaking", async () => {
  at(Math.ceil(realNow() / 3_600_000) * 3_600_000 + 1_000);
  await setup(async ({ visitor, send }) => {
    // The probe's: 30 /64s (of one /56), 20 visitors each, a message each.
    let spoke = 0;
    for (let n = 0; n < 30; n++) {
      if (n % 10 === 0 && n) shift += 61_000;
      for (let v = 0; v < 20; v++) {
        const a = await visitor(`2001:db8:8:${n.toString(16)}::${v + 1}`).catch(() => undefined);
        if (a && (await send(a, "hi")) === "done") spoke++;
      }
    }
    // Their /56 let in 80 (4 x 20 an hour), and 80 spoke: far from the line's 600.
    assertEquals(spoke, 80);
    shift += 61_000;
    const legit = await visitor("198.51.100.9");
    assertEquals(await send(legit, "hello, a room for two?"), "done");
  });
  // Visitors let in earlier, all speaking at once: a network's first messages an hour hold too.
  at(Math.ceil(realNow() / 3_600_000) * 3_600_000 + 1_000);
  await setup(async ({ visitor, send }) => {
    const waiting: Actor[] = [];
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 20; i++) waiting.push(await visitor(`2001:db8:9::${h * 20 + i + 1}`));
      shift += 3_600_000;
    }
    const said = [];
    for (const a of waiting) said.push(await send(a, "hi"));
    assertEquals(said.filter((s) => s === "done").length, 20);
    assertEquals(said.at(-1), BUSY);
  });
});

test("an erased visitor's cookie stays no one, whatever the prune finds", async () => {
  await setup(async ({ runtime, arrive, tickets }) => {
    await runtime.call("space.create", { id: "shop", name: "Shop" }, { actor: ana });
    const first = await arrive("198.51.100.20");
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    const actor = tickets.admit((await first.json()).ticket)!;
    await runtime.call("chat.send", { text: "here's my stolen cookie" }, { actor });
    await runtime.idle();
    // Erased, with its chats, in its first minutes (before any prune saw it speak).
    await runtime.call("contact.forget", { contact: actor.id, chats: true }, { actor: ana });
    at(realNow() + 11 * 60_000);
    await runtime.call("contact.prune", {});
    const [record] = await all<{ ended?: boolean }>(runtime, "contact_visitor");
    assertEquals(record.ended, true);
    const back = await arrive("198.51.100.20", {}, cookie);
    const { actor: came } = await back.json();
    assertNotEquals(came.id, actor.id);
  }, { line: { in: "shop" } });
});

/** A model each call of which uses a million input tokens: a dollar, at the app's price. */
const dollar: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "ok" };
    yield { type: "usage", input: 1_000_000, output: 0 };
  },
};
const priced = definePlugin({ name: "priced", adapters: { llm: { dollar } } });
const prices = {
  provider: { dollar: { adapter: "dollar" } },
  agents: { guide: { instructions: "Help.", model: "dollar/main" } },
  price: { "dollar/*": { input: 1 } },
};

test("a line's budget: what its visitors' turns cost today, as the ledger prices them; past it, tomorrow", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    const dani = await visitor("198.51.100.31");
    assertEquals(await send(carla, "one"), "done");
    await runtime.idle();
    assertEquals(await send(dani, "two"), "done");
    await runtime.idle();
    // Two turns, a dollar each: the budget of 2 is spent, for everyone on the line, until tomorrow.
    assertEquals(
      await send(carla, "three"),
      "too_many: This chat has done all it can for today: come back tomorrow.",
    );
    const spent = (await all<{ _id: string; spent?: number }>(runtime, "contact_rate"))
      .filter((r) => r._id.startsWith("site|spent@")).map((r) => r.spent);
    assertEquals(spent, [2]);
    at(realNow() + 86_400_000);
    assertEquals(await send(dani, "a new day"), "done");
  }, { plugins: [usage, priced], resources: prices, line: { budget: 2 } });
  // Without the usage plugin, which prices what's used, a budget stops the start.
  await assertRejects(
    () => setup(() => Promise.resolve(), { line: { budget: 2 } }),
    Error,
    "its budget needs the usage plugin",
  );
});

/** A model that looks something up, a dollar a call, until it has looked 6 times. */
const looking: LlmAdapter = {
  async *generate(request) {
    const looked = request.messages.filter((m) => m.role === "tool").length;
    yield { type: "usage", input: 1_000_000, output: 0 };
    if (looked < 6) {
      yield { type: "tool_call", call: { id: `l${looked}`, name: "look", input: {} } };
    } else yield { type: "text", text: "found it" };
  },
};
/** A model that fails before it says anything (nothing used). */
const broken: LlmAdapter = {
  // deno-lint-ignore require-yield
  async *generate() {
    throw Object.assign(new Error("down"), { final: true });
  },
};
const spending = definePlugin({
  name: "spending",
  adapters: { llm: { dollar, looking, broken } },
  resources: {
    tools: { look: { description: "Looks", run: () => "nothing yet" } },
  },
});
const charged = (runtime: Runtime) =>
  all<{ _id: string; spent?: number }>(runtime, "contact_rate").then((rs) =>
    rs.filter((r) => r._id.startsWith("site|spent@")).map((r) => r.spent ?? 0)
  );

test("a line's budget holds against messages at once: each holds its turn's cost as it goes in", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const actors = await Promise.all(
      Array.from({ length: 10 }, (_, i) => visitor(`198.51.100.${40 + i}`)),
    );
    // Before: all ten let in, $10 of a $2 budget.
    const said = await Promise.all(actors.map((a) => send(a, "hi")));
    await runtime.idle();
    assertEquals(said.filter((s) => s === "done").length, 1);
    assert(said.includes("too_many: This chat is busy right now: try again in a moment."));
    // What one cost is known now: each message holds that, so one more fits the day.
    assertEquals(await send(actors[1], "again"), "done");
    await runtime.idle();
    assertEquals(await charged(runtime), [2]);
    assertEquals(
      await send(actors[2], "and again"),
      "too_many: This chat has done all it can for today: come back tomorrow.",
    );
  }, { plugins: [usage, spending], resources: prices, line: { budget: 2 } });
});

test("a line's budget stops a turn's tool loop once it's spent", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    assertEquals(await send(carla, "look it up"), "done");
    await runtime.idle();
    // Before: seven calls, $7 of a $3 budget; now its turn stops where the day is spent.
    assertEquals(await charged(runtime), [3]);
    const said = await all<{ thread?: string; failed?: boolean; text?: string }>(
      runtime,
      "message",
    );
    assert(said.some((m) => m.failed), "the turn stopped");
  }, {
    plugins: [usage, spending],
    resources: {
      ...prices,
      agents: { guide: { instructions: "Help.", model: "looking/main", tools: ["look"] } },
      provider: { looking: { adapter: "looking" } },
      price: { "looking/*": { input: 1 } },
    },
    line: { budget: 3 },
  });
});

test("a line's budget: use nothing prices closes the line for the day; a hold never charged lapses", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    const dani = await visitor("198.51.100.31");
    // The line's model has no price: its first turn goes, then the line takes nothing more today.
    assertEquals(await send(carla, "one"), "done");
    await runtime.idle();
    // Before: every message went, nothing counted.
    assertEquals(
      await send(dani, "two"),
      "too_many: This chat has done all it can for today: come back tomorrow.",
    );
    at(realNow() + 86_400_000);
    assertEquals(await send(dani, "a new day"), "done");
  }, {
    plugins: [usage, spending],
    resources: { ...prices, price: {} },
    line: { budget: 2 },
  });
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    const dani = await visitor("198.51.100.31");
    // A turn that fails before anything's used holds the day's rest (nothing's known yet)…
    assertEquals(await send(carla, "one"), "done");
    await runtime.idle();
    assertEquals(
      await send(dani, "two"),
      "too_many: This chat is busy right now: try again in a moment.",
    );
    // …two minutes at most.
    at(realNow() + 121_000);
    assertEquals(await send(dani, "two"), "done");
  }, {
    plugins: [usage, spending],
    resources: {
      ...prices,
      agents: { guide: { instructions: "Help.", model: "broken/main" } },
      provider: { broken: { adapter: "broken" } },
    },
    line: { budget: 2 },
  });
});

/** The tool loop's setup, with the model's provider tagged as the org's own (`paid`). */
const lookingResources = (model: string | string[], provider: Record<string, unknown>) => ({
  ...prices,
  agents: { guide: { instructions: "Help.", model, tools: ["look"] } },
  provider,
  price: { "looking/*": { input: 1 }, "own/*": { input: 1 } },
});

test("a paid-tagged model (the org's own key) is stopped by the line's budget too", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    assertEquals(await send(carla, "look it up"), "done");
    await runtime.idle();
    // Before: `paid` skipped the check, and seven calls ($7) went on a $3 budget.
    assertEquals(await charged(runtime), [3]);
  }, {
    plugins: [usage, spending],
    resources: lookingResources("looking/main", {
      looking: { adapter: "looking", tags: { paid: "own-key" } },
    }),
    line: { budget: 3 },
  });
});

test("a turn can't fall over to a paid model to go on past the day's budget", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    assertEquals(await send(carla, "look it up"), "done");
    await runtime.idle();
    assertEquals(await charged(runtime), [3]);
  }, {
    plugins: [usage, spending],
    resources: lookingResources(["looking/main", "own/main"], {
      looking: { adapter: "looking" },
      own: { adapter: "looking", tags: { paid: "own-key" } },
    }),
    line: { budget: 3 },
  });
});

test("charges at once are all recorded, and messages at once on a large budget all pass", async () => {
  await setup(async ({ runtime }) => {
    const N = 40;
    // Before: charges overwrote each other, and some gave up after 8 tries.
    const results = await Promise.all(
      Array.from(
        { length: N },
        (_, i) =>
          runtime.call("contact.spent", { line: "site", contact: `c-${i}`, price: 0.25 }).then(
            () => "ok",
            (e: { code?: string; message: string }) => `${e.code}: ${e.message}`,
          ),
      ),
    );
    assertEquals(results.filter((r) => r !== "ok"), []);
    assertEquals(await charged(runtime), [N * 0.25]);
  }, { plugins: [usage, spending], resources: prices, line: { budget: 1000 } });
  await setup(async ({ runtime, visitor, send }) => {
    assertEquals(await send(await visitor("198.51.100.1"), "hi"), "done");
    await runtime.idle();
    const actors = await Promise.all(
      Array.from({ length: 40 }, (_, i) => visitor(`198.51.${101 + i}.7`)),
    );
    // Before: some of these were refused as busy, and some turns' costs were lost.
    const said = await Promise.all(actors.map((a) => send(a, "hi")));
    await runtime.idle();
    assertEquals(said.filter((s) => s !== "done"), []);
    assertEquals(await charged(runtime), [41]);
  }, { plugins: [usage, spending], resources: prices, line: { budget: 1000 } });
});

test("one call costing more than the whole budget doesn't close the line for 30 days", async () => {
  await setup(async ({ runtime, visitor, send }) => {
    const carla = await visitor("198.51.100.30");
    const dani = await visitor("198.51.100.31");
    assertEquals(await send(carla, "a long one"), "done");
    await runtime.idle();
    assertEquals(await charged(runtime), [3]);
    // The next day takes a message: it holds what's left of the budget (before: the 3 it cost).
    at(realNow() + 86_400_000);
    assertEquals(await send(dani, "next day"), "done");
    await runtime.idle();
    at(realNow() + 20 * 86_400_000);
    assertEquals(await send(dani, "much later"), "done");
  }, {
    plugins: [usage, spending],
    resources: { ...prices, price: { "dollar/*": { input: 3 } } },
    line: { budget: 2 },
  });
});

/** A CAPTCHA's check, as the app's Action: the answer "human" passes. */
const captcha = definePlugin({
  name: "captcha",
  actions: {
    "captcha.check": defineAction({
      input: { type: "object" },
      record: false,
      run: (_ctx, input) => {
        const { line, answer } = input as { line: string; answer: string };
        return line === "site" && answer === "human";
      },
    }),
  },
});

test("a line's challenge: a newcomer passes the app's check first; one back with its cookie isn't asked", async () => {
  await setup(async ({ arrive }) => {
    const said = async (r: Response) => [r.status, (await r.json()).error];
    const ASK =
      "This chat asks you to show you're a person first: reload the page, then try again.";
    assertEquals(await said(await arrive("198.51.100.40")), [403, ASK]);
    assertEquals(await said(await arrive("198.51.100.40", { challenge: "bot" })), [403, ASK]);
    const passed = await arrive("198.51.100.40", { challenge: "human" });
    assertEquals(passed.status, 200);
    const cookie = passed.headers.get("set-cookie")!.split(";")[0];
    await passed.body?.cancel();
    const back = await arrive("198.51.100.40", {}, cookie);
    assertEquals(back.status, 200);
    await back.body?.cancel();
  }, { plugins: [captcha], line: { challenge: "captcha.check" } });
  await assertRejects(
    () => setup(() => Promise.resolve(), { line: { challenge: "captcha.nowhere" } }),
    Error,
    `its challenge "captcha.nowhere" isn't one of the app's Actions`,
  );
});

test("the app's previous secret: a visitor its cookie was signed for is still who it was", async () => {
  const store = memoryStore();
  const tickets = createTickets();
  const runtimeWith = (links: Record<string, string>) =>
    createRuntime({
      store,
      plugins: [
        models,
        chat,
        ...access,
        webLines,
        definePlugin({
          name: "app",
          resources: {
            agents: { guide: { instructions: "Help.", model: "fake/echo" } },
            spaces: { visitors: { name: "Website", agents: ["guide"] } },
            links: { origin: PAGE, ...links },
            web: { site: { in: "visitors", agent: "guide" } },
          },
        }),
      ],
    });
  const connect = async (runtime: Runtime, cookie?: string) => {
    const serve = webServer({
      runtime,
      tickets,
      code: { entry: "app.js", files: { "app.js": "" } },
    });
    const r = await serve(setClientAddress(
      new Request(`${PAGE}/connect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PAGE,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ line: "site" }),
      }),
      "198.51.100.50",
    ));
    return {
      status: r.status,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
      ...(await r.json()),
    };
  };
  const old = "the-old-secret-for-web-lines-0123456789";
  let cookie: string | undefined;
  let id: string | undefined;
  const before = await runtimeWith({ secret: old });
  try {
    const came = await connect(before);
    cookie = came.cookie;
    id = came.actor.id;
    await before.call("chat.send", { text: "hi" }, { actor: tickets.admit(came.ticket)! });
    await before.idle();
  } finally {
    await before.close();
  }
  // A new secret, the old one given as previous: the cookie is the same visitor.
  const rotated = await runtimeWith({ secret: LINKS.secret, previous: old });
  try {
    assertEquals((await connect(rotated, cookie)).actor.id, id);
  } finally {
    await rotated.close();
  }
  // The old one dropped: it's no one (and asking to come in makes someone new).
  const after = await runtimeWith({ secret: LINKS.secret });
  try {
    const anew = await connect(after, cookie);
    assertEquals(anew.status, 200);
    assertNotEquals(anew.actor.id, id);
  } finally {
    await after.close();
  }
});

test("visitors all from a private address (a proxy's, without the caller resource): said once, clearly", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    await setup(async ({ arrive }) => {
      for (const from of ["10.0.0.5", "10.0.0.5", "203.0.113.9"]) {
        await (await arrive(from)).body?.cancel();
      }
    });
    await setup(async ({ arrive }) => void await (await arrive("198.51.100.1")).body?.cancel());
  } finally {
    console.warn = warn;
  }
  assertEquals(warned.length, 1);
  assert(warned[0].includes("10.0.0.5, a private address"));
  assert(warned[0].includes("caller resource"));
});
