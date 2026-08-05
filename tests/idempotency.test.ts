import { assertEquals } from "@std/assert";
import { createCopilotz, defineCollection, defineProcessor } from "../index.ts";

Deno.test("a retry after committed processor output does not duplicate mutations", async () => {
  const memory = defineCollection({
    name: "memory",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["text"],
      additionalProperties: true,
    } as const,
  });
  let attempts = 0;
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    collections: [memory],
    processors: [defineProcessor({
      id: "memory.project",
      on: ["memory.requested"],
      delivery: "durable",
      handle: async (_event, context) => {
        attempts++;
        const collections = context.collections as unknown as {
          memory: { create(value: { text: string }): Promise<unknown> };
        };
        await collections.memory.create({ text: "persist exactly once" });
        if (attempts === 1) throw new Error("crash before delivery settlement");
      },
    })],
  });
  try {
    const attachment = await copilotz.connect({
      thread: "idempotency-thread",
      participant: { externalId: "user", participantType: "human" },
    });
    const sent = await attachment.send({
      type: "memory.requested",
      payload: {},
    });
    await sent.done;
    assertEquals(attempts, 2);
    assertEquals(
      (await copilotz.deliveries.list({ correlationId: sent.correlationId }))
        .map((delivery) => ({
          status: delivery.status,
          attempts: delivery.attempts,
        })),
      [{ status: "succeeded", attempts: 2 }],
    );
    assertEquals(
      (await copilotz.events.list({ correlationId: sent.correlationId }))
        .map((event) => event.type),
      ["memory.requested", "memory.created"],
    );
    const scoped = copilotz.collections.withNamespace("default") as unknown as {
      memory: { count(): Promise<number> };
    };
    assertEquals(await scoped.memory.count(), 1);
    await attachment.close();
  } finally {
    await copilotz.shutdown();
  }
});
