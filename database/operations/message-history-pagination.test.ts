import { assertEquals } from "@std/assert";

import { createDatabase } from "../index.ts";
import { createOperations } from "./index.ts";

async function createThreadWithMessages() {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  const thread = await db.ops.findOrCreateThread(undefined, {
    namespace: "tenant-test",
    name: `Pagination Test ${suffix}`,
    participants: [`user-${suffix}`],
    status: "active",
    mode: "immediate",
  });

  for (let index = 1; index <= 4; index += 1) {
    await db.ops.createMessage({
      id: `msg-${index}-${suffix}`,
      threadId: thread.id as string,
      senderId: index % 2 === 0 ? "assistant" : `user-${suffix}`,
      senderType: index % 2 === 0 ? "agent" : "user",
      content: `Message ${index}`,
    }, "tenant-test");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  return { db, threadId: thread.id as string };
}

Deno.test({
  name: "getMessageHistoryPageFromGraph returns the latest page first",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, threadId } = await createThreadWithMessages();

    const page = await db.ops.getMessageHistoryPageFromGraph(threadId, {
      limit: 2,
    });

    assertEquals(page.data.map((message) => message.content), [
      "Message 3",
      "Message 4",
    ]);
    assertEquals(page.pageInfo, {
      hasMoreBefore: true,
      oldestMessageId: page.data[0]?.id ?? null,
      newestMessageId: page.data[1]?.id ?? null,
    });
  },
});

Deno.test({
  name:
    "getMessageHistoryPageFromGraph paginates backward from the oldest loaded message",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, threadId } = await createThreadWithMessages();

    const latestPage = await db.ops.getMessageHistoryPageFromGraph(threadId, {
      limit: 2,
    });
    const olderPage = await db.ops.getMessageHistoryPageFromGraph(threadId, {
      limit: 2,
      before: latestPage.pageInfo.oldestMessageId,
    });

    assertEquals(olderPage.data.map((message) => message.content), [
      "Message 1",
      "Message 2",
    ]);
    assertEquals(olderPage.pageInfo, {
      hasMoreBefore: false,
      oldestMessageId: olderPage.data[0]?.id ?? null,
      newestMessageId: olderPage.data[1]?.id ?? null,
    });
  },
});

Deno.test({
  name:
    "getMessageHistoryPageFromGraph returns an empty page for an unknown cursor",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, threadId } = await createThreadWithMessages();

    const page = await db.ops.getMessageHistoryPageFromGraph(threadId, {
      limit: 2,
      before: "missing-message",
    });

    assertEquals(page.data, []);
    assertEquals(page.pageInfo, {
      hasMoreBefore: false,
      oldestMessageId: null,
      newestMessageId: null,
    });
  },
});

Deno.test({
  name: "getMessageHistoryPageFromGraph normalizes null legacy content",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const thread = await db.ops.findOrCreateThread(undefined, {
      namespace: "tenant-test",
      name: "Legacy Null Content",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });

    await db.ops.createNode({
      id: "legacy-null-content-message",
      namespace: "tenant-test",
      type: "message",
      name: "legacy",
      content: null,
      data: {
        messageId: "legacy-null-content-message",
        threadId: thread.id,
        senderId: "user-1",
        senderType: "user",
      },
      sourceType: "thread",
      sourceId: thread.id as string,
    });

    const page = await db.ops.getMessageHistoryPageFromGraph(
      thread.id as string,
    );

    assertEquals(page.data[0]?.content, "");
  },
});

Deno.test({
  name: "getMessageHistoryWindowFromGraph bounds history at message cursors",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, threadId } = await createThreadWithMessages();
    const history = await db.ops.getMessageHistoryFromGraph(threadId);
    const timestamps = [
      "2026-07-31T18:28:45.297001Z",
      "2026-07-31T18:28:45.297017Z",
      "2026-07-31T18:28:45.297031Z",
      "2026-07-31T18:28:45.297049Z",
    ];
    for (let index = 0; index < history.length; index += 1) {
      await db.query(
        `UPDATE "nodes"
         SET "created_at" = $1::timestamptz
         WHERE "id" = $2`,
        [timestamps[index], history[index].id],
      );
    }

    const after = await db.ops.getMessageHistoryWindowFromGraph(
      [threadId],
      { after: history[1].id },
    );
    assertEquals(after?.map((message) => message.content), [
      "Message 3",
      "Message 4",
    ]);

    const range = await db.ops.getMessageHistoryWindowFromGraph(
      [threadId],
      { start: history[1].id, end: history[2].id },
    );
    assertEquals(range?.map((message) => message.content), [
      "Message 2",
      "Message 3",
    ]);

    assertEquals(
      await db.ops.getMessageHistoryWindowFromGraph(
        [threadId],
        { after: "missing-message" },
      ),
      null,
    );
  },
});

Deno.test("message history cursor query keeps timestamps inside the database", async () => {
  type QueryCall = { sql: string; params?: unknown[] };
  const queryCalls: QueryCall[] = [];
  let omitEndBoundary = false;
  const fakeDb = {
    crud: {},
    query: <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      queryCalls.push({ sql, params });
      if (sql.includes("COALESCE")) {
        return Promise.resolve({
          rows: [{ id: `node-${String(params?.[0])}` }] as unknown as T[],
        });
      }
      if (sql.includes('FROM "nodes" AS "message"')) {
        const rows = [{
          id: "node-start",
          namespace: "tenant-test",
          type: "message",
          name: "start",
          content: "start",
          data: {
            messageId: "start",
            threadId: "thread",
            senderId: "user",
            senderType: "user",
          },
          sourceType: "thread",
          sourceId: "thread",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }, {
          id: "node-end",
          namespace: "tenant-test",
          type: "message",
          name: "end",
          content: "end",
          data: {
            messageId: "end",
            threadId: "thread",
            senderId: "agent",
            senderType: "agent",
          },
          sourceType: "thread",
          sourceId: "thread",
          createdAt: new Date(1),
          updatedAt: new Date(1),
        }];
        return Promise.resolve({
          rows: (omitEndBoundary ? rows.slice(0, 1) : rows) as unknown as T[],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const ops = createOperations(fakeDb as never);

  const range = await ops.getMessageHistoryWindowFromGraph(
    ["thread"],
    { start: "start", end: "end" },
  );
  assertEquals(range?.map((message) => message.id), ["start", "end"]);
  const cursorLookups = queryCalls.filter((call) =>
    call.sql.includes("COALESCE")
  );
  assertEquals(cursorLookups.length, 2);
  assertEquals(
    cursorLookups.every((call) => !call.sql.includes('"created_at"')),
    true,
  );
  assertEquals(
    queryCalls.flatMap((call) => call.params ?? []).some((param) =>
      param instanceof Date
    ),
    false,
  );
  assertEquals(
    queryCalls.some((call) =>
      call.sql.includes('FROM "nodes" AS "cursor"') &&
      call.sql.includes('"message"."created_at"') &&
      call.sql.includes('"cursor"."created_at"')
    ),
    true,
  );

  omitEndBoundary = true;
  assertEquals(
    await ops.getMessageHistoryWindowFromGraph(
      ["thread"],
      { start: "start", end: "end" },
    ),
    null,
  );
});
