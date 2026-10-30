/**
 * Usage across an org: its owners and admins (and platform staff) see
 * everyone's totals and latest calls (`usage.org`, `usage.calls`), after
 * asking the org who's calling (`org.me`); anyone else sees their own, and
 * no filter of theirs reaches anyone else's. An app without org roles has
 * nobody who sees everyone's.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import usage from "../usage/mod.ts";
import { test } from "../../../testing/mod.ts";

type Totals = { key: Record<string, string>; uses: number; quantities: Record<string, number> };

/** An org whose roles are these: `org.me`, as the spaces plugin answers it. */
const org = (roles: Record<string, string>) =>
  definePlugin({
    name: "org",
    actions: {
      "org.me": defineAction({
        input: { type: "object" },
        allow: (actor) => actor.kind === "person",
        run: (ctx) => ({ role: roles[ctx.actor!.id] ?? null, staff: ctx.actor?.staff === true }),
      }),
    },
  });

const person = (id: string, staff = false): Actor => ({
  kind: "person",
  id,
  ...(staff ? { staff: true } : {}),
});

async function started(roles?: Record<string, string>) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, usage, ...(roles ? [org(roles)] : [])],
  });
  const uses = [
    ["ana", "assistant", "openai/gpt-5.4-mini", 1000],
    ["ana", "researcher", "openai/gpt-5.4-mini", 2000],
    ["bob", "assistant", "openai/gpt-5.4-mini", 4000],
    ["carol", "assistant", "openai/gpt-5.4-mini", 8000],
  ] as const;
  for (const [n, [who, agent, subject, input]] of uses.entries()) {
    await runtime.call("usage.record", {
      // A second apart, so the latest are in a known order.
      at: new Date(Date.now() - (uses.length - n) * 1000).toISOString(),
      meter: "llm",
      subject,
      catalog: subject,
      quantities: { input, output: 10 },
      tags: { person: who, agent },
    });
  }
  return runtime;
}

const byPerson = (totals: Totals[]) =>
  Object.fromEntries(totals.map((t) => [t.key["tags.person"], t.quantities.input]));

test("the org's owners and admins see everyone's totals; members their own", async () => {
  const runtime = await started({ ana: "owner", bob: "admin", carol: "member" });
  try {
    for (const who of ["ana", "bob"]) {
      const { totals, all } = await runtime.call<{ totals: Totals[]; all: boolean }>(
        "usage.org",
        { by: ["tags.person"] },
        { actor: person(who) },
      );
      assertEquals(all, true);
      assertEquals(byPerson(totals), { ana: 3000, bob: 4000, carol: 8000 });
    }
    const carol = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.person"] },
      { actor: person("carol") },
    );
    assertEquals(carol.all, false);
    assertEquals(byPerson(carol.totals), { carol: 8000 });
  } finally {
    await runtime.close();
  }
});

test("a member's filter never reaches anyone else's usage", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    for (
      const filter of [
        { "tags.person": "ana" },
        { $or: [{ "tags.person": "ana" }, { "tags.person": "bob" }] },
        { "tags.agent": "researcher" },
      ]
    ) {
      const { totals } = await runtime.call<{ totals: Totals[] }>(
        "usage.org",
        { filter, by: ["tags.person"] },
        { actor: person("carol") },
      );
      assertEquals(Object.keys(byPerson(totals)).filter((p) => p !== "carol"), []);
    }
  } finally {
    await runtime.close();
  }
});

test("platform staff see everyone's; the latest calls, newest first, by the same rule", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    const staff = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.agent"] },
      { actor: person("sam", true) },
    );
    assertEquals(staff.all, true);
    assertEquals(
      Object.fromEntries(staff.totals.map((t) => [t.key["tags.agent"], t.uses])),
      { assistant: 3, researcher: 1 },
    );
    const everyone = await runtime.call<{ calls: { tags: { person: string } }[]; all: boolean }>(
      "usage.calls",
      { limit: 3 },
      { actor: person("ana") },
    );
    assertEquals(everyone.all, true);
    assertEquals(everyone.calls.map((c) => c.tags.person), ["carol", "bob", "ana"]);
    const own = await runtime.call<{ calls: { tags: { person: string } }[]; all: boolean }>(
      "usage.calls",
      { filter: { "tags.person": "ana" } },
      { actor: person("carol") },
    );
    assertEquals(own.all, false);
    assertEquals(own.calls.map((c) => c.tags.person), ["carol"]);
  } finally {
    await runtime.close();
  }
});

test("without org roles, everyone sees their own; outside callers are refused", async () => {
  const runtime = await started();
  try {
    const { totals, all } = await runtime.call<{ totals: Totals[]; all: boolean }>(
      "usage.org",
      { by: ["tags.person"] },
      { actor: person("ana") },
    );
    assertEquals(all, false);
    assertEquals(byPerson(totals), { ana: 3000 });
    await assertRejects(() =>
      runtime.call("usage.org", {}, { actor: { kind: "key", id: "k1" } as Actor })
    );
  } finally {
    await runtime.close();
  }
});

test("everyone sees prices; what it cost, and so the margin, only platform staff", async () => {
  const runtime = await started({ ana: "owner", carol: "member" });
  try {
    type Seen = { totals: Record<string, unknown>[]; costs: boolean };
    type Calls = { calls: Record<string, unknown>[]; costs: boolean };
    for (const [who, sees] of [[person("ana"), false], [person("carol"), false]] as const) {
      const org = await runtime.call<Seen>("usage.org", {}, { actor: who });
      assertEquals(org.costs, sees);
      assertEquals([org.totals[0].cost, org.totals[0].costs], [undefined, undefined]);
      assert((org.totals[0].price as number) > 0, "the price");
      const calls = await runtime.call<Calls>("usage.calls", {}, { actor: who });
      assertEquals(calls.costs, false);
      assert(calls.calls.every((c) => c.cost === undefined && (c.price as number) > 0));
    }
    const staff = await runtime.call<Seen>("usage.org", {}, { actor: person("sam", true) });
    assertEquals(staff.costs, true);
    // No price book: the price is the cost.
    assertEquals(staff.totals[0].price, staff.totals[0].cost);
    const calls = await runtime.call<Calls>("usage.calls", {}, { actor: person("sam", true) });
    assert(calls.calls.every((c) => c.cost === c.price));
  } finally {
    await runtime.close();
  }
});
