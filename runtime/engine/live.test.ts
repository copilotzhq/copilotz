import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { defineCollection } from "../domain/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createSqlSession } from "../events/index.ts";
import {
  type CopilotzLiveProcessorContext,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";

const auditCollection = defineCollection({
  name: "live_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      sourceType: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "sourceType"],
  } as const,
});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("live processors mutate causally without delivery rows or capacity-one deadlock", async () => {
  let liveCalls = 0;
  let durableCalls = 0;
  let leakedDelivery = false;
  const live = defineProcessor<CopilotzLiveProcessorContext>({
    id: "test.live-message-audit",
    on: ["message.created"],
    delivery: "live",
    async handle(event, context) {
      liveCalls += 1;
      leakedDelivery = leakedDelivery || "delivery" in context;
      assertEquals(context.event.type, event.type);
      await context.collections.live_audit.create({
        id: `audit:${event.durable ? event.id : event.correlationId}`,
        sourceType: event.type,
      });
    },
  });
  const durable = defineProcessor<CopilotzProcessorContext>({
    id: "test.observe-live-audit",
    on: ["live_audit.created"],
    delivery: "durable",
    handle() {
      durableCalls += 1;
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.live",
        version: "1.0.0",
        provides: {
          processors: [live.id, durable.id],
          collections: [auditCollection.name],
        },
      },
      resources: {
        processors: [live, durable],
        collections: [auditCollection],
      },
    })],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "copilotz_live_nested",
    execution: { capacity: 1 },
  });
  try {
    await engine.conversation.createThread({
      namespace: "tenant-live",
      id: "thread-a",
      participants: [
        {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
      ],
    });
    const content = await engine.content.preparer.prepare("hello", {
      namespace: "tenant-live",
      idempotencyKey: "live-message:content",
    });
    const result = await engine.conversation.createMessage({
      namespace: "tenant-live",
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      content,
      identity: {
        correlationId: "live-root",
        deduplicationId: "live-message:create",
      },
    });
    assertEquals(liveCalls, 1);
    assertEquals(leakedDelivery, false);
    await waitUntil(async () => {
      const settlement = await engine.events.settlement(
        "tenant-live",
        result.event.id,
      );
      return settlement.unsettled === 0 && settlement.succeeded === 1;
    });
    assertEquals(durableCalls, 1);

    const audit = await engine.collections.get("live_audit").get(
      "tenant-live",
      `audit:${result.event.id}`,
    );
    assertExists(audit);
    const deliveries = await engine.deliveries.list({
      namespace: "tenant-live",
    });
    assertEquals(deliveries.length, 1);
    assertEquals(deliveries[0].consumerId, `processor:${durable.id}`);
    const events = await engine.events.list({ namespace: "tenant-live" });
    const auditEvent = events.find((event) =>
      event.type === "live_audit.created"
    );
    assertExists(auditEvent);
    assertEquals(auditEvent.causationId, result.event.id);
    assertEquals(
      typeof auditEvent.metadata.sourceLiveDispatchId,
      "string",
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("live subscription failures remain independent and ephemeral", async () => {
  const calls: string[] = [];
  const good = defineProcessor<CopilotzLiveProcessorContext>({
    id: "test.live-good",
    on: ["cursor.changed"],
    delivery: "live",
    handle() {
      calls.push("good");
    },
  });
  const bad = defineProcessor<CopilotzLiveProcessorContext>({
    id: "test.live-bad",
    on: ["cursor.changed"],
    delivery: "live",
    handle() {
      calls.push("bad");
      throw new Error("synthetic live failure");
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.live-errors",
        version: "1.0.0",
        provides: { processors: [good.id, bad.id] },
      },
      resources: { processors: [good, bad] },
    })],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "copilotz_live_errors",
    execution: { capacity: 2 },
  });
  try {
    const observed = engine.events.subscribe({
      namespace: "tenant-live",
      types: ["cursor.changed"],
    }).getReader();
    await assertRejects(
      () =>
        engine.events.emit({
          type: "cursor.changed",
          namespace: "tenant-live",
          payload: { x: 12 },
          correlationId: "cursor-a",
        }),
      AggregateError,
      "live processor operation",
    );
    assertEquals(calls.sort(), ["bad", "good"]);
    const event = await observed.read();
    assertEquals(event.value?.durable, false);
    assertEquals(event.value?.type, "cursor.changed");
    await observed.cancel();
    assertEquals(
      await engine.events.list({ namespace: "tenant-live" }),
      [],
    );
    assertEquals(
      await engine.deliveries.list({ namespace: "tenant-live" }),
      [],
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("live execution modules remain factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("../execution/live.ts", import.meta.url),
  );
  assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/\bclass\s+\w+/.test(source));
  assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source));
});
