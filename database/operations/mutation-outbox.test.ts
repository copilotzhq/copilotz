import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "../index.ts";

Deno.test({
  name: "domain mutations write lifecycle outbox rows and canonical nodes",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `mutation-outbox-${suffix}`;
    const thread = await db.ops.mutate.threads.create(undefined, {
      namespace,
      name: "Mutation Outbox Test",
      participants: [`user-${suffix}`],
      status: "active",
      mode: "immediate",
    });
    const threadId = String(thread.id);

    const message = await db.ops.mutate.messages.create({
      id: `msg-${suffix}`,
      threadId,
      senderId: `user-${suffix}`,
      senderType: "user",
      content: "hello",
    }, namespace);

    await db.ops.mutate.messages.appendSegments(
      message.id,
      [{ kind: "text", content: "hello" }],
      { threadId, namespace },
    );

    const attempt = await db.ops.mutate.llmAttempts.create({
      threadId,
      messageId: message.id,
      eventId: `event-${suffix}`,
      agentId: "assistant",
      agentName: "Assistant",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      namespace,
    });

    await db.ops.mutate.llmAttempts.complete(String(attempt.id), {
      answer: "hi",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cost: { totalCostUsd: 0.000001 },
      finishedAt: new Date().toISOString(),
    }, { threadId, namespace });

    const execution = await db.ops.mutate.toolExecutions.create({
      threadId,
      messageId: message.id,
      eventId: `tool-event-${suffix}`,
      agentId: "assistant",
      agentName: "Assistant",
      toolCallId: `tool-call-${suffix}`,
      tool: { id: "lookup", name: "Lookup" },
      args: { q: "x" },
      namespace,
    });

    await db.ops.mutate.toolExecutions.complete(String(execution.id), {
      output: { ok: true },
      finishedAt: new Date().toISOString(),
    }, { threadId, namespace });

    const output = await db.ops.mutate.toolExecutions.getOutput(
      String(execution.id),
      threadId,
    );
    assertExists(output);
    assertEquals(output.output, { ok: true });

    await db.ops.mutate.assets.create({
      id: `asset-${suffix}`,
      threadId,
      ref: `asset://${suffix}`,
      mime: "text/plain",
      by: "tool",
      namespace,
    });

    const lifecycle = await db.query<
      {
        eventType: string;
        subjectType: string;
        operation: string;
        status: string;
      }
    >(
      `SELECT "eventType", "subjectType", "operation", "status"
       FROM "events"
       WHERE "threadId" = $1
         AND "eventType" IN (
           'asset.created',
           'thread.created',
           'message.created',
           'message.updated',
           'llm_attempt.created',
           'llm_attempt.completed',
           'tool_execution.created',
           'tool_execution.completed'
         )
       ORDER BY "createdAt" ASC, "id" ASC`,
      [threadId],
    );

    assertEquals(
      lifecycle.rows.map((row) => row.eventType).sort(),
      [
        "asset.created",
        "llm_attempt.completed",
        "llm_attempt.created",
        "message.created",
        "message.updated",
        "thread.created",
        "tool_execution.completed",
        "tool_execution.created",
      ].sort(),
    );
    assertEquals(
      lifecycle.rows.every((row) =>
        row.eventType === `${row.subjectType}.${row.operation}`
      ),
      true,
    );
    assertEquals(
      lifecycle.rows.every((row) => row.status === "completed"),
      true,
    );

    const completedAttempt = await db.query<
      {
        payload: Record<string, unknown>;
        input: Record<string, unknown> | null;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        patch: Record<string, unknown> | null;
      }
    >(
      `SELECT "payload", "input", "before", "after", "patch"
       FROM "events"
       WHERE "threadId" = $1
         AND "eventType" = 'llm_attempt.completed'
       LIMIT 1`,
      [threadId],
    );

    assertEquals(completedAttempt.rows[0]?.payload?.answer, "hi");
    assertEquals(completedAttempt.rows[0]?.input, null);
    assertEquals(completedAttempt.rows[0]?.before, null);
    assertEquals(completedAttempt.rows[0]?.after, null);
    assertEquals(completedAttempt.rows[0]?.patch, null);
  },
});

Deno.test({
  name: "domain lifecycle outbox append is centralized behind domainMutation",
  fn: async () => {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const directLifecycleCalls = [...source.matchAll(/await lifecycleEvent\(/g)]
      .length;

    assertEquals(
      directLifecycleCalls,
      1,
      "Only domainMutation may call lifecycleEvent directly",
    );
    assertEquals(
      source.includes("await lifecycleEvent(event);"),
      true,
      "domainMutation must be the outbox emission point for domain mutations",
    );
  },
});

Deno.test({
  name: "unsafeGraph writes bypass lifecycle outbox rows explicitly",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `unsafe-graph-${suffix}`;
    const thread = await db.ops.mutate.threads.create(undefined, {
      namespace,
      name: "Unsafe Graph Test",
      participants: [`user-${suffix}`],
      status: "active",
      mode: "immediate",
    });
    const threadId = String(thread.id);
    const nodeId = `raw-${suffix}`;

    await db.ops.unsafeGraph.createNode({
      id: nodeId,
      namespace,
      type: "raw_test",
      name: "Raw Test",
      data: { threadId },
      sourceType: "test",
      sourceId: suffix,
    });
    await db.ops.unsafeGraph.updateNode(nodeId, {
      data: { threadId, updated: true },
    });

    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "events"
       WHERE "subjectId" = $1
         AND "eventType" IN ('raw_test.created', 'raw_test.updated')`,
      [nodeId],
    );

    assertEquals(rows.rows[0]?.count, 0);
  },
});

Deno.test({
  name:
    "safe graph mutations require a topic and write semantic lifecycle rows",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `safe-graph-${suffix}`;
    const thread = await db.ops.mutate.threads.create(undefined, {
      namespace,
      name: "Safe Graph Test",
      participants: [`user-${suffix}`],
      status: "active",
      mode: "immediate",
    });
    const threadId = String(thread.id);
    const nodeId = `entity-${suffix}`;

    const node = await db.ops.mutate.graph.createNode({
      id: nodeId,
      namespace,
      type: "entity",
      name: "Important Entity",
      content: "first",
      data: { source: "test" },
      sourceType: "test",
      sourceId: suffix,
    }, {
      threadId,
      namespace,
      traceId: `trace-${suffix}`,
      causationId: `cause-${suffix}`,
    });
    assertEquals(node.id, nodeId);

    await db.ops.mutate.graph.updateNode(nodeId, {
      content: "second",
      data: { source: "test", updated: true },
    }, { threadId, namespace });

    const edge = await db.ops.mutate.graph.createEdge({
      sourceNodeId: threadId,
      targetNodeId: nodeId,
      type: "mentions",
      data: { via: "test" },
    }, { threadId, namespace });

    await db.ops.mutate.graph.deleteEdge(String(edge.id), {
      threadId,
      namespace,
    });
    await db.ops.mutate.graph.deleteNode(nodeId, { threadId, namespace });

    const rows = await db.query<{
      eventType: string;
      threadId: string;
      subjectType: string;
      operation: string;
      subjectId: string;
    }>(
      `SELECT "eventType", "threadId", "subjectType", "operation", "subjectId"
       FROM "events"
       WHERE "threadId" = $1
         AND (
           "subjectId" = $2
           OR "subjectId" = $3
         )
       ORDER BY "createdAt" ASC, "id" ASC`,
      [threadId, nodeId, String(edge.id)],
    );

    assertEquals(
      rows.rows.map((row) => row.eventType),
      [
        "entity.created",
        "entity.updated",
        "edge.created",
        "edge.deleted",
        "entity.deleted",
      ],
    );
    assertEquals(
      rows.rows.every((row) =>
        row.threadId === threadId &&
        row.eventType === `${row.subjectType}.${row.operation}`
      ),
      true,
    );
  },
});

Deno.test({
  name: "thread mutations create update and fork lifecycle events",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const namespace = `thread-mutations-${suffix}`;

    const source = await db.ops.mutate.threads.create(undefined, {
      namespace,
      name: "Source Thread",
      participants: [`user-${suffix}`],
      metadata: { public: { label: "source" } },
      status: "active",
      mode: "immediate",
    });

    const updated = await db.ops.mutate.threads.update(String(source.id), {
      participants: [`user-${suffix}`, `guest-${suffix}`],
      metadata: { public: { label: "updated" } },
    }, { namespace });
    assertExists(updated);
    assertEquals(updated.metadata, { public: { label: "updated" } });

    const fork = await db.ops.mutate.threads.fork({
      sourceThreadId: String(source.id),
      namespace,
      name: "Forked Thread",
      participants: [`user-${suffix}`],
      metadata: { public: { label: "fork" } },
    }, { namespace });

    assertEquals(fork.parentThreadId, source.id);
    assertEquals(fork.rootThreadId, source.rootThreadId ?? source.id);
    assertEquals(fork.metadata, { public: { label: "fork" } });

    const lifecycle = await db.query<
      {
        eventType: string;
        operation: string;
        subjectId: string;
        payload: Record<string, unknown> | null;
        input: Record<string, unknown> | null;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        patch: Record<string, unknown> | null;
      }
    >(
      `SELECT "eventType", "operation", "subjectId",
              "payload", "input", "before", "after", "patch"
       FROM "events"
       WHERE "threadId" IN ($1, $2)
         AND "eventType" IN ('thread.created', 'thread.updated', 'thread.forked')
       ORDER BY "createdAt" ASC, "id" ASC`,
      [String(source.id), String(fork.id)],
    );

    assertEquals(
      lifecycle.rows.map((row) => row.eventType).sort(),
      [
        "thread.created",
        "thread.created",
        "thread.forked",
        "thread.updated",
      ].sort(),
    );
    assertEquals(
      lifecycle.rows.some((row) =>
        row.eventType === "thread.updated" &&
        row.payload?.metadata !== undefined
      ),
      true,
    );
    assertEquals(
      lifecycle.rows.every((row) =>
        row.input === null && row.before === null && row.after === null &&
        row.patch === null
      ),
      true,
    );
  },
});

Deno.test({
  name: "ops.transaction rolls back outbox writes",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const suffix = crypto.randomUUID();
    const thread = await db.ops.findOrCreateThread(undefined, {
      namespace: `rollback-${suffix}`,
      name: "Rollback Test",
      participants: [`user-${suffix}`],
      status: "active",
      mode: "immediate",
    });
    const threadId = String(thread.id);
    const eventType = `test.rollback.${suffix}`;

    await assertRejects(
      () =>
        db.ops.transaction(async (ops) => {
          await ops.outbox.append({
            threadId,
            eventType,
            subjectType: "test",
            subjectId: suffix,
            operation: "created",
          });
          throw new Error("rollback please");
        }),
      Error,
      "rollback please",
    );

    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "events"
       WHERE "threadId" = $1 AND "eventType" = $2`,
      [threadId, eventType],
    );

    assertEquals(rows.rows[0]?.count, 0);
  },
});
