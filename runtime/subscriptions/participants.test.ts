import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import { fixture, reader } from "../testing/subscriptions.ts";

Deno.test("SEC3 participant ID batches equal list through live inserts, updates and deletes", async () => {
  const f = await fixture({}, {
    collections: {
      participant: defineCollection({
        name: "participant",
        schema: { type: "object", properties: { name: { type: "string" } } },
      }),
    },
  });
  const batch = Array.from({ length: 32 }, (_, i) => `person-${i}`);
  batch[0] = "𐀀";
  batch[1] = "\ue000";
  const query = { where: { id: { in: batch } }, limit: batch.length };
  const subscriptions = [];
  try {
    await f.collections.participant.create({ id: batch[0], name: "First" });
    await f.collections.participant.create({ id: "unselected", name: "Other" });
    const sub = await f.observe(f.authority, "participant", query);
    subscriptions.push(sub);
    const frames = reader(sub);
    const snapshot = await frames.next();
    assert(snapshot.t === "snapshot");
    assertEquals(snapshot.rows, await f.collections.participant.list(query));
    const rows = new Map(snapshot.rows.map((row) => [row.id, row]));
    for (
      const change of [
        () =>
          f.collections.participant.create({ id: batch[1], name: "Second" }),
        () =>
          f.collections.participant.update({
            id: batch[0],
            set: { name: "Renamed" },
          }),
        () => f.collections.participant.delete({ id: batch[1] }),
      ]
    ) {
      await change();
      const frame = await frames.next();
      assert(frame.t === "batch");
      for (const item of frame.changes) {
        if (item.record) rows.set(item.id, item.record);
        else rows.delete(item.id);
      }
      const listed = await f.collections.participant.list(query);
      assertEquals(new Map(listed.map((row) => [row.id, row])), rows);
    }
    for (
      const id of [batch[0], { eq: batch[0] }, { in: [] }, {
        in: [null, 1, batch[0], batch[0]],
      }]
    ) {
      const selection = { where: { id }, limit: 32 };
      const equality = await f.observe(f.authority, "participant", selection);
      subscriptions.push(equality);
      const frame = await reader(equality).next();
      assert(frame.t === "snapshot");
      assertEquals(frame.rows, await f.collections.participant.list(selection));
    }
    const error = await assertRejects(() =>
      f.observe(f.authority, "participant", {
        where: { id: { in: [...batch, "over-limit"] } },
        limit: 32,
      })
    );
    assertEquals((error as { reason?: string }).reason, "limit_exceeded");
  } finally {
    for (const sub of subscriptions) sub.detach();
    await f.close();
  }
});
