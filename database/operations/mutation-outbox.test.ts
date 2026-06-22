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

    const lifecycle = await db.query<
      { eventType: string; subjectType: string }
    >(
      `SELECT "eventType", "subjectType"
       FROM "events"
       WHERE "threadId" = $1
         AND "eventType" IN (
           'thread.created',
           'message.created',
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
        "llm_attempt.completed",
        "llm_attempt.created",
        "message.created",
        "thread.created",
        "tool_execution.completed",
        "tool_execution.created",
      ].sort(),
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
        patch: Record<string, unknown> | null;
      }
    >(
      `SELECT "eventType", "operation", "subjectId", "patch"
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
        row.patch?.metadata !== undefined
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
