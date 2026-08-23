import { assert, assertEquals, assertExists } from "@std/assert";

import type { AgentResource } from "@copilotz/copilotz/core";
import { createCopilotzApplication } from "../../runtime/application/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { corePlugin, message } from "../core/index.ts";
import { createUsageWorkflowPlugin } from "../usage/index.ts";
import { createAdminPlugin } from "./plugin.ts";
import { createTestDomainContext } from "../core/testing/context.ts";

const SCHEMA = "copilotz_admin_plugin";
const NAMESPACE = "tenant-a";

const supportAgent: AgentResource = {
  id: "support",
  name: "Support",
  role: "support",
  models: {},
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

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("admin plugin projects Collection state without raw storage access", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [
      corePlugin,
      createUsageWorkflowPlugin({ enabled: false }),
      createAdminPlugin(),
    ],
    resources: { agents: { [supportAgent.id]: supportAgent } },
  });
  try {
    await createTestDomainContext(application, NAMESPACE).actions.createThread({
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
    await createTestDomainContext(application, "tenant-b").actions.createThread(
      {
        id: "thread-b",
        participants: [{
          id: "user-b",
          externalId: "external-user-b",
          participantType: "human",
        }],
      },
    );
    const sent = await application.send(message({
      correlationId: "admin-run-a",
      thread: "thread-a",
      participant: {
        id: "user-a",
        externalId: "external-user-a",
        participantType: "human",
      },
      id: "message-a",
      recipientIds: [],
      content: "Admin-visible message",
    }));
    await sent.done;

    const usageCollection = application.collections.withScope({
      namespace: NAMESPACE,
    }).usage;
    await usageCollection.create({
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
    });
    await usageCollection.create({
      id: "usage-tool-a",
      kind: "tool",
      resource: "search",
      threadId: "thread-a",
      agentId: "support",
      initiatedById: "external-user-a",
      status: "completed",
      occurredAt: new Date().toISOString(),
    });

    const admin = createTestDomainContext(application, NAMESPACE).actions;
    const request = (action: string, query?: Record<string, string>) => {
      const caller = admin[`admin${action[0].toUpperCase()}${action.slice(1)}`];
      if (!caller) throw new Error(`Admin Action '${action}' was not found.`);
      return caller({
        resource: "admin",
        method: "GET",
        query,
      }) as Promise<{ status: number; data?: unknown }>;
    };

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
    assertEquals(object(overview.toolTotals).totalCalls, 1);
    assertEquals("deliveryTotals" in overview, false);

    const activity = array(
      (await request("activity", { interval: "day" })).data,
    );
    assertEquals(activity.length, 1);
    assertEquals(object(activity[0]).messageCount, 1);
    assertEquals(object(activity[0]).toolCallCount, 1);
    assertEquals(object(activity[0]).totalCalls, 1);

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

    assertEquals("adminEvents" in admin, false);
    assertEquals("adminBrain" in admin, false);

    const agents = array((await request("agents")).data);
    assertEquals(object(agents[0]).id, "support");
    assertEquals("instructions" in object(agents[0]), false);

    const rejected = await admin.adminOverview({
      resource: "admin",
      method: "POST",
    }) as { status: number; data?: unknown };
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
