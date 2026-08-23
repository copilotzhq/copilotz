import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
} from "../../runtime/testing/projections.ts";
import { createSqlSession } from "../events/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import {
  type CopilotzLiveProcessorContext,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineCollection } from "../collections/index.ts";

const auditCollection = defineCollection({
  name: "live_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      sourceType: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "sourceType"],
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
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      liveCalls += 1;
      leakedDelivery = leakedDelivery || "delivery" in context;
      assertEquals(context.event.type, event.type);
      await context.collections.liveAudit.create({
        id: `audit:${event.durable ? event.id : event.correlationId}`,
        sourceType: event.type,
      });
    },
  });
  const durable = defineProcessor<CopilotzProcessorContext>({
    id: "test.observe-live-audit",
    on: [{ eventType: "live_audit.created" }],
    handle() {
      durableCalls += 1;
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        id: "test.live",
        version: "1.0.0",
        processors: { observeLiveAudit: durable },
        collections: { liveAudit: auditCollection },
      }),
    ],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    transientProcessors: [live],
    defaultDatabaseSchema: "copilotz_live_nested",
    execution: { capacity: 1 },
  });
  try {
    await createTestDomainContext(engine, "tenant-live").actions.createThread(
      {
        id: "thread-a",
        participants: [
          {
            id: "user-a",
            externalId: "user-a",
            participantType: "human",
          },
        ],
      },
    );
    await createTestDomainContext(engine, "tenant-live").actions
      .createThreadMessage({
        id: "message-a",
        threadId: "thread-a",
        sender: {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        content: "hello",
      }, {
        identity: {
          correlationId: "live-root",
          deduplicationId: "live-message:create",
        },
      });
    const resultEvent = (await engine.events.list({
      namespace: "tenant-live",
      threadId: "thread-a",
      limit: 100,
    })).find((event) => event.subject?.id === "message-a");
    assertExists(resultEvent);
    assertEquals(liveCalls, 1);
    assertEquals(leakedDelivery, false);
    await waitUntil(async () => durableCalls === 1);
    assertEquals(durableCalls, 1);

    const audit = await engine.collections.get("live_audit").get(
      "tenant-live",
      `audit:${resultEvent.id}`,
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
    assertEquals(auditEvent.causationId, resultEvent.id);
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
    on: [{ eventType: "cursor.changed" }],
    handle() {
      calls.push("good");
    },
  });
  const bad = defineProcessor<CopilotzLiveProcessorContext>({
    id: "test.live-bad",
    on: [{ eventType: "cursor.changed" }],
    handle() {
      calls.push("bad");
      throw new Error("synthetic live failure");
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.live-errors",
      version: "1.0.0",
    })],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    transientProcessors: [good, bad],
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
      "live processor(s) failed",
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

Deno.test("transient catch-up replays committed events without delivery rows", async () => {
  const seen: string[] = [];
  const observer = defineProcessor({
    id: "test.transient-catch-up",
    on: [{ eventType: "thread.created" }],
    handle(event) {
      if (event.durable) seen.push(event.id);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        id: "test.transient-catch-up",
        version: "1.0.0",
      }),
    ],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "copilotz_transient_catchup",
  });
  try {
    await createTestDomainContext(engine, "tenant-live").actions.createThread(
      {
        id: "thread-a",
        participants: [{
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        }],
      },
    );
    const firstEvent = (await engine.events.list({
      namespace: "tenant-live",
      limit: 100,
    })).find((event) => event.subject?.id === "thread-a");
    assertExists(firstEvent);
    assertEquals(seen, []);
    const unbind = await engine.bindTransient(observer, {
      namespace: "tenant-live",
      afterPosition: "0",
    });
    assertEquals(seen, [firstEvent.id]);
    await createTestDomainContext(engine, "tenant-live").actions.createThread(
      {
        id: "thread-b",
        participants: [{
          id: "user-b",
          externalId: "user-b",
          participantType: "human",
        }],
      },
    );
    const secondEvent = (await engine.events.list({
      namespace: "tenant-live",
      limit: 100,
    })).find((event) => event.subject?.id === "thread-b");
    assertExists(secondEvent);
    await waitUntil(() => seen.includes(secondEvent.id));
    assertEquals(seen, [firstEvent.id, secondEvent.id]);
    assertEquals(
      (await engine.deliveries.list({ namespace: "tenant-live" })).length,
      0,
    );
    unbind();
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
