/**
 * Computers' asks and yeses, as they were kept before chat kept every ask
 * (on a `desk`), kept as chat keeps them: what a yes is for (`on`), the
 * answers each ask takes, its words; nothing else changes. A routine's
 * standing yes and an "always" still let what they let; what waits is still
 * answered. Run again, it changes nothing.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models from "../../models/mod.ts";
import { type Approval, ask, chat, type Grant } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { computers } from "../mod.ts";
import { answersFor } from "../computers/shared/ask.ts";
import type { UpgradeLog } from "../computers/shared/upgrade.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const at = "2026-11-01T10:00:00.000Z";
const kept = { owner: "ana", for: "ana", computer: "c1", name: "laptop", thread: "t1", in: "p1" };

/** As computers kept them: a command waiting in a turn, a publish waiting, one answered. */
const approvals = [
  {
    _id: "a-df",
    ...kept,
    desk: "d1",
    agent: "assistant",
    work: "terminal",
    detail: "df",
    call: "run1:0:0",
    question: "run1:0:0:question",
    status: "pending",
    at,
  },
  {
    _id: "a-publish",
    ...kept,
    desk: "d1",
    agent: "assistant",
    work: "publish",
    detail: "publish Shop",
    preview: "https://shop.example",
    origin: { kind: "routine", id: "r1", name: "Daily", rev: 2 },
    status: "pending",
    at,
  },
  {
    _id: "a-done",
    ...kept,
    desk: "d1",
    agent: "assistant",
    work: "writes",
    detail: "write a.md",
    status: "allowed",
    grant: "thread",
    at,
    decided: at,
  },
];

/** And what Ana let: always, in one conversation, once, and whenever a routine runs. */
const grants = [
  {
    _id: "g-always",
    owner: "ana",
    desk: "d1",
    computer: "c1",
    agent: "assistant",
    work: "writes",
    at,
  },
  {
    _id: "g-thread",
    owner: "ana",
    desk: "d1",
    computer: "c1",
    agent: "assistant",
    work: "jobs",
    thread: "t1",
    at,
  },
  {
    _id: "g-once",
    owner: "ana",
    desk: "d1",
    computer: "c1",
    agent: "assistant",
    work: "terminal",
    once: "ls",
    thread: "t1",
    at,
  },
  {
    _id: "g-routine",
    owner: "ana",
    desk: "d1",
    computer: "c1",
    agent: "assistant",
    work: "terminal",
    origin: "routine:r1",
    rev: 2,
    at,
  },
];

/** Asks as a computer would (outside a turn): `true` when a yes already lets it. */
const probe = definePlugin({
  name: "probe",
  actions: {
    "test.ask": defineAction({
      input: {
        type: "object",
        properties: {
          work: { type: "string" },
          detail: { type: "string" },
          thread: { type: "string" },
        },
        required: ["work", "detail", "thread"],
      },
      allow: () => true,
      run: (ctx, input) =>
        ask(ctx, {
          owner: "ana",
          for: "ana",
          agent: "assistant",
          thread: input.thread,
          work: input.work,
          on: "d1",
          computer: "c1",
          detail: input.detail,
          answers: answersFor(input.work, true),
          doing: "do this",
          question: "May I?",
        }),
    }),
    "test.kept": defineAction({
      input: {
        type: "object",
        properties: { collection: { type: "string" } },
        required: ["collection"],
      },
      run: (ctx, input) => ctx.db.collection(input.collection).find({}, { sort: { _id: 1 } }),
    }),
  },
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
};

const maintainer: Actor = { kind: "maintenance", id: "maintenance" };
const plugins = [models, chat, ...access, computers, probe];
/** A release before this one: it doesn't run by itself. */
const before = definePlugin({ name: "before", schedules: { "computer.upgradeAsks": null } });

/** A store with computers' old documents in it, as they kept them. */
async function seeded(make: () => Store | Promise<Store>): Promise<Store> {
  const store = await make();
  const { epoch } = await store.open();
  await store.transaction(epoch, async (tx) => {
    await tx.insert("approval", approvals);
    await tx.insert("grant", grants);
  });
  return store;
}

/** The lines it logs while `fn` runs, as JSON. */
async function logging<T>(fn: (lines: UpgradeLog[]) => Promise<T>): Promise<T> {
  const lines: UpgradeLog[] = [];
  const print = console.log;
  console.log = (line: unknown) => {
    const parsed = typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined;
    if (parsed?.migration === "computer.upgradeAsks") lines.push(parsed);
    else print(line);
  };
  try {
    return await fn(lines);
  } finally {
    console.log = print;
  }
}

/** Asked as the agent at work for Ana, in a routine's run (`rev`) or not. */
const asking = (rt: Runtime, input: Record<string, unknown>, rev?: number) => {
  const ana: Actor = {
    kind: "person",
    id: "ana",
    ...(rev ? { origin: { kind: "routine", id: "r1", name: "Daily", rev } } : {}),
  };
  return rt.call("test.ask", input, { actor: { kind: "agent", id: "assistant", for: ana } });
};

/** What's kept now: asks and yeses. */
const keptNow = async (rt: Runtime) => ({
  asked: await rt.call<Approval[]>("test.kept", { collection: "approval" }),
  given: await rt.call<Grant[]>("test.kept", { collection: "grant" }),
});

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: a dry run says what it would change; run, they mean what they meant`, async () => {
    const rt = await createRuntime({ store: await seeded(make), plugins: [...plugins, before] });
    try {
      // Kept the old way, a routine's standing yes lets nothing: its runs would stop and wait.
      assert((await asking(rt, { work: "terminal", detail: "df", thread: "t9" }, 2)) !== true);
      const old = await keptNow(rt);

      // Only an operator calls it; a dry run reads, says, and writes nothing.
      await assertRejects(() =>
        rt.call("computer.upgradeAsks", {}, { actor: { kind: "person", id: "ana" } })
      );
      const dry = await logging(async (lines) => {
        const said = await rt.call("computer.upgradeAsks", { dryRun: true }, { actor: maintainer });
        assertEquals(lines.map((l) => [l.dryRun, l.approvals, l.grants]), [[true, 3, 4]]);
        return said;
      });
      assertEquals(dry, {
        dryRun: true,
        approvals: 3,
        grants: 4,
        ids: {
          approvals: ["a-df", "a-publish", "a-done"],
          grants: ["g-always", "g-thread", "g-once", "g-routine"],
        },
      });
      const stillOld = await keptNow(rt);
      assertEquals(
        stillOld.asked.filter((a) => old.asked.some((b) => b._id === a._id)),
        old.asked,
      );
      assertEquals(stillOld.given, old.given);

      const done = await logging(async (lines) => {
        const said = await rt.call("computer.upgradeAsks", {}, { actor: maintainer });
        assertEquals(lines.map((l) => [l.dryRun, l.approvals, l.grants]), [[false, 3, 4]]);
        return said;
      });
      assertEquals(done, { dryRun: false, approvals: 3, grants: 4 });
      const { asked, given } = await keptNow(rt);
      const upgraded = asked.filter((a) => approvals.some((b) => b._id === a._id));
      assert([...upgraded, ...given].every((d) => !("desk" in d) && d.on === "d1"));
      const byId = Object.fromEntries(upgraded.map((a) => [a._id, a]));
      assertEquals(byId["a-df"].answers, ["once", "thread", "always", "deny"]);
      assertEquals([byId["a-df"].text, byId["a-df"].covers], [
        "run df on laptop",
        "run commands on laptop",
      ]);
      // Publishing, asked in a routine's run, still once or no.
      assertEquals(byId["a-publish"].answers, ["once", "deny"]);
      // Nothing else changed: who, what, where, its question, its answer, what it was.
      const { desk: _, ...before } = approvals[0];
      for (const [field, value] of Object.entries(before)) {
        assertEquals((byId["a-df"] as Record<string, unknown>)[field], value, field);
      }
      assertEquals([byId["a-done"].status, byId["a-done"].grant], ["allowed", "thread"]);
      const routine = given.find((g) => g._id === "g-routine")!;
      assertEquals([routine.origin, routine.rev, routine.work], ["routine:r1", 2, "terminal"]);

      // The routine's standing yes lets its runs go again, at the version it was given for only.
      assertEquals(await asking(rt, { work: "terminal", detail: "df", thread: "t9" }, 2), true);
      assert((await asking(rt, { work: "terminal", detail: "df", thread: "t9" }, 3)) !== true);
      // "Always" lets it in any conversation; one conversation's, only there.
      assertEquals(await asking(rt, { work: "writes", detail: "write b.md", thread: "t9" }), true);
      assertEquals(await asking(rt, { work: "jobs", detail: "start dev", thread: "t1" }), true);
      assert((await asking(rt, { work: "jobs", detail: "start dev", thread: "t9" })) !== true);
      // Once, used up by what it let.
      assertEquals(await asking(rt, { work: "terminal", detail: "ls", thread: "t1" }), true);

      // Run again, nothing changes. (Asking above left asks of its own: only these are compared.)
      assertEquals(await rt.call("computer.upgradeAsks", {}, { actor: maintainer }), {
        dryRun: false,
        approvals: 0,
        grants: 0,
      });
      const again = await keptNow(rt);
      assertEquals(again.asked.filter((a) => upgraded.some((b) => b._id === a._id)), upgraded);
    } finally {
      await rt.close();
    }
  });
}

test("on the first start with it, it runs by itself, once, and says so in one line", async () => {
  const store = await seeded(memoryStore);
  const first = await logging(async (lines) => {
    const rt = await createRuntime({ store, plugins });
    await rt.idle();
    return { rt, lines };
  });
  try {
    assertEquals(
      first.lines.map(({ severity, migration, dryRun, approvals, grants }) => ({
        severity,
        migration,
        dryRun,
        approvals,
        grants,
      })),
      [{
        severity: "NOTICE",
        migration: "computer.upgradeAsks",
        dryRun: false,
        approvals: 3,
        grants: 4,
      }],
    );
    const { asked, given } = await keptNow(first.rt);
    assert([...asked, ...given].every((d) => !("desk" in d) && d.on === "d1"));
  } finally {
    await first.rt.close();
  }
  // Started again with it: it ran already, and says nothing.
  const again = await logging(async (lines) => {
    const rt = await createRuntime({ store, plugins });
    await rt.idle();
    await rt.close();
    return lines;
  });
  assertEquals(again, []);
});
