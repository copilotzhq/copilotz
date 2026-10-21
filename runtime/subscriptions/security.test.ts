import { assert, assertEquals, assertRejects } from "@std/assert";
import { fixture, reader } from "../testing/subscriptions.ts";

Deno.test("SEC3 live admission refuses costly and locale-dependent predicates", async () => {
  const f = await fixture();
  try {
    for (
      const filter of [
        { field: "id", in: Array.from({ length: 33 }, (_, i) => `${i}`) },
        { field: "tags", overlaps: Array.from({ length: 33 }, (_, i) => i) },
        { field: "title", jsonEquals: "a" },
        { field: "createdAt", exists: true },
        { field: "title", eq: "\ud800" },
        { field: "title", eq: "\0" },
        { field: "title", eqIgnoreCase: "a" },
        { field: "title", inIgnoreCase: ["a"] },
        { and: Array.from({ length: 65 }, () => ({ field: "id", eq: "a" })) },
      ]
    ) {
      const error = await assertRejects(() =>
        f.observe(f.authority, "entry", { filter })
      );
      assertEquals(
        (error as { code?: string }).code,
        "subscription_query_refused",
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 principal quota and detached eviction do not lock out a victim", async () => {
  const f = await fixture();
  const subs = [];
  try {
    for (let i = 0; i < 32; i++) {
      subs.push(await f.observe(f.authority, "entry", { limit: i + 1 }));
    }
    const error = await assertRejects(() => f.observe(f.authority, "entry"));
    assertEquals(
      (error as { code?: string }).code,
      "subscription_capacity_exceeded",
    );
    for (const sub of subs) sub.detach();
    for (let i = 0; i < 256; i++) {
      (await f.observe(f.authority, "entry", { limit: i + 1 })).detach();
    }
    const victim = await f.observe({
      ...f.authority,
      principal: { kind: "api-key", id: "victim" },
      authorityBasis: { kind: "credential", id: "victim" },
    }, "entry");
    assertEquals((await reader(victim).next()).t, "snapshot");
    victim.detach();
  } finally {
    for (const sub of subs) sub.detach();
    await f.close();
  }
});

Deno.test("SEC3 invisible writes emit no row or progress signal", async () => {
  const f = await fixture();
  try {
    await f.collections.member.update({ id: "key", set: { restricted: true } });
    for (const progressOnly of [false, true]) {
      const sub = await f.observe(f.authority, "entry", {}, { progressOnly });
      const r = reader(sub);
      const initial = await r.next();
      assert(initial.t === "snapshot");
      await f.collections.entry.create({
        id: `hidden-${progressOnly}`,
        visible: false,
      });
      await f.collections.entry.create({
        id: `visible-${progressOnly}`,
        visible: true,
      });
      const next = await r.next();
      assert(next.t === "batch");
      assertEquals(next.from, initial.sequence);
      assertEquals(BigInt(next.to), BigInt(initial.sequence) + 2n);
      assertEquals(next.collectionChanged, true);
      assertEquals(
        next.changes.map((c) => c.id),
        progressOnly ? [] : [`visible-${progressOnly}`],
      );
      await f.collections.entry.update({
        id: `visible-${progressOnly}`,
        set: { visible: false },
      });
      const exit = await r.next();
      assert(exit.t === "batch");
      assertEquals(
        exit.collectionChanged,
        true,
        "old policy-visible records invalidate on exit",
      );
      assertEquals(
        exit.changes.map((change) => [change.id, change.record]),
        progressOnly ? [] : [[`visible-${progressOnly}`, null]],
      );
      sub.detach();
    }
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 commits evaluate only changed rows and never serialize predicate constants", async () => {
  const f = await fixture();
  const subs = [];
  const stringify = JSON.stringify;
  try {
    for (let i = 0; i < 64; i++) {
      await f.collections.entry.create({
        id: `r${i}`,
        title: `unchanged-row-${i}`,
      });
    }
    const constants = Array.from(
      { length: 32 },
      (_, i) => `predicate-constant-${i}`,
    );
    for (let i = 0; i < 16; i++) {
      const sub = await f.observe(f.authority, "entry", {
        filter: { field: "title", in: constants },
        limit: i + 1,
      });
      subs.push(sub);
      await reader(sub).next();
    }
    let unchanged = 0, serializedConstants = 0;
    JSON.stringify = new Proxy(stringify, {
      apply(target, context, args) {
        if (typeof args[0] === "string") {
          if (args[0].startsWith("unchanged-row-")) unchanged++;
          if (args[0].startsWith("predicate-constant-")) serializedConstants++;
        }
        return Reflect.apply(target, context, args);
      },
    });
    await f.collections.entry.create({ id: "new", title: "changed-row" });
    JSON.stringify = stringify;
    assertEquals(
      serializedConstants,
      0,
      "constant encodings must be compiled at admission",
    );
    assertEquals(
      unchanged,
      0,
      "commit must not reevaluate unchanged cache records",
    );
  } finally {
    JSON.stringify = stringify;
    for (const sub of subs) sub.detach();
    await f.close();
  }
});

Deno.test("SEC3 accepted scalar filters match SQL list including Unicode ranges", async () => {
  const f = await fixture();
  try {
    for (
      const [i, title] of ["A", "a", "é", "z", "\ue000", "𐀀", " ", ""].entries()
    ) {
      await f.collections.entry.create({
        id: `r${i}`,
        title,
        n: i,
        tags: [i, "tag"],
        visible: i % 2 === 0,
      });
    }
    for (
      const filter of [
        { field: "title", gt: "z" },
        { field: "title", lte: "𐀀" },
        { field: "title", ne: "a" },
        { field: "title", in: ["a", "é"] },
        { field: "n", gte: 3 },
        { field: "tags", overlaps: [1, 3] },
        { field: "title", trimEq: "" },
        { field: "title", isBlank: true },
        { field: "missing", exists: false },
        { not: { field: "missing", isNull: true } },
        { and: [{ field: "visible", eq: true }, { field: "n", lt: 6 }] },
      ]
    ) {
      const query = { filter, limit: 100 };
      const sub = await f.observe(f.authority, "entry", query);
      try {
        const snapshot = await reader(sub).next();
        assert(snapshot.t === "snapshot");
        const listed = await f.collections.entry.list(query);
        assertEquals(
          snapshot.rows.map((r) => r.id),
          listed.map((r) => r.id),
          JSON.stringify(filter),
        );
      } finally {
        sub.detach();
      }
    }
    for (const id of ["é", "z", "A", "a", "\ue000", "𐀀"]) {
      await f.collections.entry.create({ id, title: id });
    }
    for (const direction of ["asc", "desc"] as const) {
      const query = {
        order: { field: "id", direction },
        filter: { field: "id", gt: "A" },
      };
      const sub = await f.observe(f.authority, "entry", query);
      const snap = await reader(sub).next();
      assert(snap.t === "snapshot");
      assertEquals(
        snap.rows.map((row) => row.id),
        (await f.collections.entry.list(query)).map((row) => row.id),
      );
      sub.detach();
    }
    const sub = await f.observe(f.authority, "entry");
    const r = reader(sub);
    const initial = await r.next();
    assert(initial.t === "snapshot");
    await f.run("other namespace", {}, async (_, command) => {
      await f.store.commitMutation({
        draft: { namespace: "other", type: "unrelated", payload: {} },
        consumers: [],
        transaction: command.transaction,
      });
    });
    await f.collections.entry.create({ id: "local" });
    const next = await r.next();
    assert(next.t === "batch");
    assertEquals(
      BigInt(next.to),
      BigInt(initial.sequence) + 1n,
      "other namespace progress is not observable",
    );
    sub.detach();
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 malformed content options cannot strand the owner admission queue", async () => {
  const f = await fixture();
  try {
    const content: Record<string, unknown> = {};
    content.cycle = content;
    await assertRejects(() => f.observe(f.authority, "entry", {}, { content }));
    const admitted = f.observe(f.authority, "entry");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sub = await Promise.race([
        admitted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Admission queue stranded")),
            5000,
          );
        }),
      ]);
      assertEquals((await reader(sub).next()).t, "snapshot");
      sub.detach();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await f.close();
  }
});
