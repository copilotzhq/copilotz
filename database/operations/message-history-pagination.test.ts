import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "../index.ts";

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
