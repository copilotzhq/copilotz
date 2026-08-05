import { assert, assertEquals } from "@std/assert";
import { createCopilotz, defineProcessor } from "../index.ts";

Deno.test("asset bytes stay external while metadata uses event-native delivery", async () => {
  const observed: string[] = [];
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    processors: [defineProcessor({
      id: "asset.observe",
      on: ["asset.created"],
      delivery: "durable",
      handle(event) {
        observed.push(event.id);
      },
    })],
  });

  try {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const saved = await copilotz.assets.save(bytes, "audio/wav", {
      namespace: "tenant-assets",
      threadId: "thread-assets",
      by: "user:42",
      metadata: { purpose: "test" },
    });

    for (let index = 0; index < 20 && observed.length < 1; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const stored = await copilotz.assets.get(saved.ref);
    assertEquals([...stored.bytes], [...bytes]);
    assertEquals(stored.mime, "audio/wav");
    assertEquals(observed.length, 1);

    const events = await copilotz.events.list({ namespace: "tenant-assets" });
    assertEquals(events.map((event) => event.type), ["asset.created"]);
    assertEquals(events[0].threadId, "thread-assets");
    const payload = events[0].payload as {
      record: Record<string, unknown>;
    };
    assertEquals(payload.record.ref, saved.ref);
    assertEquals(payload.record.mime, "audio/wav");
    assertEquals(payload.record.threadId, "thread-assets");
    assert(!("bytes" in payload.record));
    assert(!JSON.stringify(events[0]).includes("[1,2,3,4]"));

    const deliveries = await copilotz.deliveries.list({
      namespace: "tenant-assets",
      eventId: events[0].id,
    });
    assertEquals(deliveries.map((delivery) => delivery.status), ["succeeded"]);
    assertEquals(
      await copilotz.deliveries.list({ eventId: events[0].id }),
      [],
    );
    assertEquals(await copilotz.deliveries.get(deliveries[0].id), null);
    assertEquals(
      (await copilotz.deliveries.get(deliveries[0].id, {
        namespace: "tenant-assets",
      }))?.status,
      "succeeded",
    );
  } finally {
    await copilotz.shutdown();
  }
});
