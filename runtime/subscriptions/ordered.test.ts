import { assert, assertEquals } from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import type { CollectionQuery } from "../collections/types.ts";
import { createLiveQuery, type LiveQuery } from "../../client/live-query.ts";
import { fixture } from "../testing/subscriptions.ts";

Deno.test("SEC3 ordered live windows equal list after inserts, moves, ties, deletes and refill", async () => {
  let tick = Date.parse("2026-01-01T00:00:00Z");
  const schema: Parameters<typeof defineCollection>[0]["schema"] = {
    type: "object",
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      title: { type: ["string", "null"] },
      rank: { type: ["number", "null"] },
      active: { type: ["boolean", "null"] },
    },
  };
  const f = await fixture({}, {
    now: () => new Date(tick),
    collections: {
      thread: defineCollection({ name: "thread", schema }),
      message: defineCollection({ name: "message", schema }),
    },
  });
  const live: {
    handle: LiveQuery;
    collection: string;
    query: CollectionQuery;
    frames: number;
  }[] = [];
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error("Ordered live window timed out");
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  const subscribe = async (collection: string, query: CollectionQuery) => {
    const item = {
      handle: undefined! as LiveQuery,
      collection,
      query,
      frames: 0,
    };
    item.handle = createLiveQuery(
      {
        observe: (alias, query, options) =>
          f.observe(f.authority, alias, query, options),
      },
      collection,
      query,
      {
        onState(frame) {
          if (frame) item.frames++;
        },
      },
    );
    void item.handle.done.catch(() => {});
    live.push(item);
    await wait(() => item.handle.status === "ready");
  };
  const equal = async () => {
    for (const item of live) {
      assertEquals(
        item.handle.rows,
        await f.collections[item.collection].list(item.query),
        JSON.stringify(item.query),
      );
    }
  };
  const change = async (collection: string, work: () => Promise<unknown>) => {
    const active = live.filter((item) => item.collection === collection);
    const counts = active.map((item) => item.frames);
    await work();
    await wait(() => active.every((item, i) => item.frames > counts[i]));
    await equal();
  };
  try {
    for (let i = 0; i < 105; i++) {
      await f.collections.message.create({
        id: `m${String(i).padStart(3, "0")}`,
        threadId: "a",
        title: "tie",
      });
    }
    await f.collections.message.create({ id: "other-thread", threadId: "b" });
    for (const [i, title] of ["A", "z", "é", "\ue000", "𐀀", null].entries()) {
      await f.collections.thread.create({
        id: `t${i}`,
        title,
        rank: i % 3,
        active: i % 2 === 0,
      });
    }
    // Preserve physical SQL microseconds even when the public timestamp has none.
    await f.db.query(
      `UPDATE "${f.schema}".nodes SET created_at='2026-01-01T00:00:00.000001Z' WHERE namespace='main' AND type='message' AND id='m000'`,
    );
    // The exact Core conversation-feed shape, with more than one window of rows.
    await subscribe("message", {
      where: { threadId: "a" },
      order: { field: "createdAt", direction: "desc" },
      limit: 100,
    });
    await subscribe("thread", {
      order: { field: "updatedAt", direction: "desc" },
      limit: 30,
    });
    for (const field of ["createdAt", "updatedAt", "title", "rank", "active"]) {
      for (const direction of ["asc", "desc"] as const) {
        await subscribe("thread", { order: { field, direction }, limit: 3 });
      }
    }
    await equal();
    tick += 1000;
    await change(
      "thread",
      () =>
        f.collections.thread.create({
          id: "new",
          title: "é",
          rank: 1,
          active: false,
        }),
    );
    tick += 1000;
    await change(
      "thread",
      () =>
        f.collections.thread.update({
          id: "t0",
          set: { title: "𐀀", rank: 99, active: false },
        }),
    );
    tick += 1000;
    await change(
      "thread",
      () =>
        f.collections.thread.update({
          id: "new",
          set: { title: null, rank: null, active: null },
        }),
    );
    await change("thread", () => f.collections.thread.delete({ id: "t0" }));
    await change("thread", () => f.collections.thread.delete({ id: "new" }));
    tick += 1000;
    await change(
      "message",
      () => f.collections.message.create({ id: "latest", threadId: "a" }),
    );
    assertEquals(live[0].handle.rows[0].id, "latest");
    await change(
      "message",
      () => f.collections.message.delete({ id: "latest" }),
    );
    assertEquals(live[0].handle.rows.length, 100);
    assert(!live[0].handle.rows.some((row) => row.id === "other-thread"));
  } finally {
    for (const item of live) item.handle.close();
    await f.close();
  }
});
