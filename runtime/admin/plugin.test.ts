import { assert, assertEquals, assertExists } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createEventNativeApp } from "../../server/event-native.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import { createSqlSession } from "../events/index.ts";
import { createLongTermMemoryPlugin } from "../memory/index.ts";
import { createUsageWorkflowPlugin } from "../usage/index.ts";
import { createAdminPlugin } from "./plugin.ts";

const SCHEMA = "copilotz_admin_plugin";
const NAMESPACE = "tenant-a";

const supportAgent: Agent = {
  id: "support",
  name: "Support",
  role: "support",
  instructions: "Private instructions",
};

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  assert(Array.isArray(value));
  return value;
}

async function collect(
  stream: ReadableStream<CopilotzEvent>,
): Promise<readonly CopilotzEvent[]> {
  const result: CopilotzEvent[] = [];
  for await (const value of stream) result.push(value);
  return result;
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("admin plugin projects event-native application state without raw storage access", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    core: false,
    plugins: [
      createUsageWorkflowPlugin({ enabled: false }),
      createLongTermMemoryPlugin({ enabled: false }),
      createAdminPlugin(),
    ],
    resources: { agents: [supportAgent] },
  });
  const app = createEventNativeApp(application);
  try {
    await application.conversation.createThread({
      namespace: NAMESPACE,
      id: "thread-a",
      externalId: "external-thread-a",
      metadata: { name: "Visible thread", summary: "A useful summary" },
      participants: [{
        id: "user-a",
        externalId: "external-user-a",
        participantType: "human",
        name: "Alice",
      }, {
        id: "agent-a",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
        name: "Support",
      }],
    });
    await application.conversation.createThread({
      namespace: "tenant-b",
      id: "thread-b",
      participants: [{
        id: "user-b",
        externalId: "external-user-b",
        participantType: "human",
      }],
    });
    const run = await application.run({
      thread: "thread-a",
      participant: "user-a",
      content: "Admin-visible message",
      messageId: "message-a",
      correlationId: "admin-run-a",
    });
    const observed = collect(run.events);
    await run.done;
    await observed;

    await application.collections.get("usage").create({
      id: "usage-a",
      kind: "llm",
      resource: "test-model",
      provider: "test-provider",
      threadId: "thread-a",
      agentId: "support",
      initiatedById: "external-user-a",
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 17,
      totalCostUsd: 0.03,
      occurredAt: new Date().toISOString(),
    }, { namespace: NAMESPACE });

    await application.collections.get("memory_space").create({
      id: "memory-a",
      scopeType: "thread",
      scopeId: "thread-a",
      threadId: "thread-a",
      access: "read_write",
      defaultWrite: true,
    }, { namespace: NAMESPACE });
    await application.collections.get("long_term_memory").create({
      id: "checkpoint-a",
      threadId: "thread-a",
      schemaVersion: "3",
      strategy: "rolling",
      status: "ready",
      memorySpaceId: "memory-a",
      readMemorySpaceIds: ["memory-a"],
      writeMemorySpaceIds: ["memory-a"],
      defaultWriteMemorySpaceId: "memory-a",
      sequence: 1,
      agentId: "support",
      sourceStartMessageId: "message-a",
      sourceEndMessageId: "message-a",
    }, { namespace: NAMESPACE });
    const brain = application.collections.get("brain_node");
    for (
      const [id, name, kind] of [
        ["brain-a", "Decision", "decision"],
        ["brain-b", "Next action", "next_action"],
      ] as const
    ) {
      await brain.create({
        id,
        memorySpaceId: "memory-a",
        checkpointId: "checkpoint-a",
        createdByAgentId: "support",
        originThreadId: "thread-a",
        layer: "knowledge",
        status: "active",
        kind,
        name,
        content: `${name} content`,
        sourceMessageIds: ["message-a"],
      }, { namespace: NAMESPACE });
    }
    await application.relations.create({
      namespace: NAMESPACE,
      id: "brain-relation-a",
      type: "related_to",
      source: { type: "brain_node", id: "brain-a" },
      target: { type: "brain_node", id: "brain-b" },
      threadId: "thread-a",
    });

    const request = (action: string, query?: Record<string, string>) =>
      app.handle({
        resource: "features",
        method: "GET",
        path: ["admin", action],
        query,
      });

    const overview = object((await request("overview")).data);
    assertEquals(object(overview.threadTotals).total, 1);
    assertEquals(object(overview.messageTotals).total, 1);
    assertEquals(object(overview.participantTotals).total, 2);
    assertEquals(object(overview.llmTotals), {
      totalCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 17,
      totalCostUsd: 0.03,
    });

    const activity = array(
      (await request("activity", { interval: "day" })).data,
    );
    assertEquals(activity.length, 1);
    assertEquals(object(activity[0]).messageCount, 1);
    assertEquals(object(activity[0]).totalCalls, 1);

    const events = array(
      (await request("events", {
        correlationId: "admin-run-a",
      })).data,
    );
    assertEquals(events.length, 1);
    assertEquals(object(events[0]).type, "message.created");
    assertEquals("status" in object(events[0]), false);

    const threads = array(
      (await request("threads", { search: "visible" })).data,
    );
    assertEquals(threads.length, 1);
    assertEquals(object(threads[0]).threadId, "thread-a");
    assertEquals(
      object(threads[0]).lastMessagePreview,
      "Admin-visible message",
    );

    const participants = array(
      (await request("participants", {
        participantType: "human",
      })).data,
    );
    assertEquals(participants.length, 1);
    assertEquals(object(participants[0]).externalId, "external-user-a");
    assertEquals(object(participants[0]).messageCount, 1);

    const usage = array((await request("usage", { kind: "llm" })).data);
    assertEquals(usage.length, 1);
    assertEquals(object(usage[0]).id, "usage-a");

    const brainProjection = object(
      (await request("brain", {
        status: "active",
      })).data,
    );
    assertEquals(array(brainProjection.nodes).length, 2);
    assert(
      array(brainProjection.edges).some((value) =>
        object(value).id === "brain-relation-a"
      ),
    );
    assertEquals(array(brainProjection.stats).length, 2);

    const agents = array((await request("agents")).data);
    assertEquals(object(agents[0]).id, "support");
    assertEquals("instructions" in object(agents[0]), false);

    const rejected = await app.handle({
      resource: "features",
      method: "POST",
      path: ["admin", "overview"],
    });
    assertEquals(rejected.status, 405);
    assertExists(object(rejected.data).code);
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("admin plugin remains factory-first, runtime-neutral, and storage-opaque", async () => {
  for (
    const module of ["plugin.ts", "projections.ts", "types.ts", "index.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assertEquals(/\bclass\s+\w+/.test(source), false, module);
    assertEquals(/\bDeno\b|\bBun\b|\bprocess\b/.test(source), false, module);
    assertEquals(/from\s+["']node:/.test(source), false, module);
    assertEquals(
      /unsafeGraph|queueId|queueTTL|ackMode/.test(source),
      false,
      module,
    );
    assertEquals(
      /\.query\s*\(|\bSELECT\b|\bINSERT\b|\bDELETE FROM\b/.test(source),
      false,
      module,
    );
    assertEquals(/server\//.test(source), false, module);
  }
});
