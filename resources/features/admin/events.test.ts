import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import events from "./events.ts";

Deno.test("admin events lists queue rows with namespace and exact filters", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-events";
  const otherNamespace = "tenant-other";
  const threadId = crypto.randomUUID();
  const otherThreadId = crypto.randomUUID();

  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Events Thread",
    participants: [],
  });
  await db.ops.findOrCreateThread(otherThreadId, {
    namespace: otherNamespace,
    name: "Other Events Thread",
    participants: [],
  });

  const completed = await db.ops.addToQueue(threadId, {
    eventType: "TOOL_CALL",
    payload: { toolName: "sandbox.exec", args: { command: "pwd" } },
    priority: 5,
    status: "completed",
    traceId: "trace-tool",
    metadata: { source: "test" },
    namespace,
  });
  const pending = await db.ops.addToQueue(threadId, {
    eventType: "NEW_MESSAGE",
    payload: { content: "hello" },
    status: "pending",
    traceId: "trace-message",
    namespace,
  });
  await db.ops.addToQueue(otherThreadId, {
    eventType: "TOOL_CALL",
    payload: { toolName: "hidden" },
    status: "completed",
    traceId: "trace-other",
    namespace: otherNamespace,
  });

  const copilotz = { ops: db.ops } as any;
  const scopedResult = await events({
    query: { namespace, threadId, limit: "10" },
  }, copilotz);
  const scopedData = scopedResult.data as any[];

  assertEquals(scopedResult.status, 200);
  const scopedIds = new Set(scopedData.map((row) => row.id));
  assertEquals(scopedIds.has(completed.id), true);
  assertEquals(scopedIds.has(pending.id), true);
  assertEquals(scopedData.every((row) => row.namespace === namespace), true);
  assertEquals(scopedData.every((row) => row.threadId === threadId), true);

  const completedResult = await events({
    query: {
      namespace,
      threadId,
      status: "completed",
      eventType: "TOOL_CALL",
      traceId: "trace-tool",
    },
  }, copilotz);
  const completedData = completedResult.data as any[];

  assertEquals(completedData.length, 1);
  assertEquals(completedData[0].id, completed.id);
  assertEquals(completedData[0].payload, {
    toolName: "sandbox.exec",
    args: { command: "pwd" },
  });
  assertEquals(completedData[0].priority, 5);
  assertEquals(completedData[0].metadata, { source: "test" });
});

Deno.test("admin events supports search across event identifiers", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-events-search";
  const threadId = crypto.randomUUID();

  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Events Search Thread",
    participants: [],
  });
  await db.ops.addToQueue(threadId, {
    eventType: "LLM_CALL",
    payload: { model: "gpt-test" },
    status: "pending",
    traceId: "trace-searchable",
    namespace,
  });

  const result = await events({
    query: { namespace, search: "searchable" },
  }, { ops: db.ops } as any);
  const data = result.data as any[];

  assertEquals(data.length, 1);
  assertEquals(data[0].eventType, "LLM_CALL");
  assertEquals(data[0].traceId, "trace-searchable");
});
