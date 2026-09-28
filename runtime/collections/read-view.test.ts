import { assert, assertEquals } from "@std/assert";

import { createReadViews, readViewKey } from "./read-view.ts";

const remember = (
  views: ReturnType<typeof createReadViews>,
  key: string,
  value: unknown,
) => views.memo()!.begin([key]).remember(key, value);

Deno.test("there is no view outside a hop", () => {
  const views = createReadViews();
  assertEquals(views.memo(), undefined);
});

Deno.test("a hop recalls what it read, including a missing row, as copies", async () => {
  const views = createReadViews();
  await views.run(async () => {
    const memo = views.memo()!;
    assertEquals(memo.recall("row"), undefined);
    remember(views, "row", { id: "a", tags: ["x"] });
    remember(views, "missing", null);

    const first = memo.recall<{ id: string; tags: string[] }>("row")!.value;
    first.tags.push("changed");
    assertEquals(memo.recall("row")!.value, { id: "a", tags: ["x"] });
    assertEquals(memo.recall("missing"), { value: null });
    await Promise.resolve();
  });
});

Deno.test("hops do not see each other's reads", async () => {
  const views = createReadViews();
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const first = views.run(async () => {
    remember(views, "row", "first");
    await held;
    return views.memo()!.recall("row");
  });
  const second = views.run(async () => {
    const seen = views.memo()!.recall("row");
    remember(views, "row", "second");
    release();
    return seen;
  });
  assertEquals(await second, undefined);
  assertEquals(await first, { value: "first" });
});

Deno.test("this process's own write voids what a hop remembered", async () => {
  const views = createReadViews();
  await views.run(async () => {
    remember(views, "row", "old");
    views.invalidate("row");
    assertEquals(views.memo()!.recall("row"), undefined);
    remember(views, "row", "new");
    assertEquals(views.memo()!.recall("row"), { value: "new" });
    await Promise.resolve();
  });
});

Deno.test("a read that started before a write cannot remember its result", async () => {
  const views = createReadViews();
  await views.run(async () => {
    const ticket = views.memo()!.begin(["row"]);
    views.invalidate("row"); // the write lands while the read is in flight
    ticket.remember("row", "stale");
    assertEquals(views.memo()!.recall("row"), undefined);
    await Promise.resolve();
  });
});

Deno.test("a write that cannot name its rows voids every remembered row", async () => {
  const views = createReadViews();
  await views.run(async () => {
    remember(views, "a", 1);
    remember(views, "b", 2);
    views.invalidateAll();
    assertEquals(views.memo()!.recall("a"), undefined);
    assertEquals(views.memo()!.recall("b"), undefined);
    remember(views, "a", 3);
    assertEquals(views.memo()!.recall("a"), { value: 3 });
    await Promise.resolve();
  });
});

Deno.test("a remembered row expires so a long handler does not go stale", async () => {
  let clock = 0;
  const views = createReadViews({ ttlMs: 1_000, now: () => clock });
  await views.run(async () => {
    remember(views, "row", "old");
    clock = 1_000;
    assertEquals(views.memo()!.recall("row"), { value: "old" });
    clock = 1_001;
    assertEquals(views.memo()!.recall("row"), undefined);
    // Expiry is measured from when the read started, not from the recall.
    const ticket = views.memo()!.begin(["row"]);
    clock = 2_500;
    ticket.remember("row", "slow read");
    assertEquals(views.memo()!.recall("row"), undefined);
    await Promise.resolve();
  });
});

Deno.test("only rows a read declared can be remembered by its ticket", async () => {
  const views = createReadViews();
  await views.run(async () => {
    views.memo()!.begin(["declared"]).remember("other", "value");
    assertEquals(views.memo()!.recall("other"), undefined);
    await Promise.resolve();
  });
});

Deno.test("tracking many written rows falls back to voiding everything", async () => {
  const views = createReadViews();
  await views.run(async () => {
    remember(views, "kept", 1);
    for (let index = 0; index <= 10_000; index++) {
      views.invalidate(`written:${index}`);
    }
    assert(views.memo()!.recall("kept") === undefined);
    await Promise.resolve();
  });
});

Deno.test("row keys separate schema, namespace, collection and id", () => {
  assert(
    readViewKey("s", "n", "c", "a b") !== readViewKey("s", "n", "c a", "b"),
  );
});
