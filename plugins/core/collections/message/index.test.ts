import { assertEquals, assertRejects } from "@std/assert";
import type { CollectionNamedQueryRead } from "../../../../runtime/collections/definition.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createSqlSession } from "../../../../runtime/events/index.ts";
import { queryCollectionRecords } from "../../../../runtime/collections/query.ts";
import { createResolvedCollectionReader } from "../../../../runtime/collections/resolved-read.ts";
import {
  createContentResolver,
  createMemoryAssetRepository,
} from "../../../../runtime/content/index.ts";
import type { CollectionQuery } from "../../../../runtime/collections/types.ts";
import { messageCollection } from "./index.ts";

Deno.test("Message Collection owns its name", () =>
  assertEquals(messageCollection.name, "message"));

/** Exercise Core's query against the real SQL compiler and content reader. */
async function fixture(
  records: Record<string, unknown>[],
  branch?: Record<string, string>,
) {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const tables = { nodes: "history_nodes", edges: "unused_edges" };
  await session.query(
    `CREATE TABLE history_nodes (id text, namespace text, type text, data jsonb, created_at timestamptz, updated_at timestamptz, content text)`,
  );
  const rows = records.map((record, index) => ({
    namespace: "tenant",
    threadId: "thread",
    senderId: "human",
    content: [],
    metadata: {},
    createdAt: new Date(index * 1_000).toISOString(),
    ...record,
  }));
  await session.query(
    `INSERT INTO history_nodes SELECT r->>'id', r->>'namespace', 'message', r, (r->>'createdAt')::timestamptz, (r->>'createdAt')::timestamptz, '' FROM jsonb_array_elements($1::jsonb) r`,
    [JSON.stringify(rows)],
  );
  const assets = createMemoryAssetRepository();
  const assetReads: string[] = [];
  const resolver = createContentResolver({
    assets,
    authorize: ({ ref }) => {
      assetReads.push(ref.assetId);
      return true;
    },
  });
  const pages: CollectionQuery[] = [];
  const list = createResolvedCollectionReader(
    (query: CollectionQuery) => {
      pages.push(query);
      return queryCollectionRecords(
        session,
        tables,
        messageCollection,
        "tenant",
        query,
      );
    },
    messageCollection,
    "tenant",
    resolver,
  );
  let beforeResolve: (() => Promise<void>) | undefined;
  const read: CollectionNamedQueryRead = {
    async get(collection, id) {
      if (collection === "thread") return { id, activeMessageBranch: branch };
      return (await list({ where: { id }, limit: 1 }))[0] ?? null;
    },
    async list(_collection, query = {}, options) {
      if (options?.content) await beforeResolve?.();
      return list(query, options);
    },
    async aggregate() {
      throw new Error("Message history fixture does not support aggregation.");
    },
  };
  return {
    assets,
    beforeResolve(callback: () => Promise<void>) {
      beforeResolve = callback;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      await session.query(
        "UPDATE history_nodes SET data = data || $1::jsonb WHERE id = $2",
        [JSON.stringify(patch), id],
      );
    },
    assetReads,
    pages,
    select: (input: Record<string, unknown> = {}) =>
      messageCollection.queries!.history.select!({
        input: {
          threadId: "thread",
          viewerParticipantIds: ["human"],
          ...input,
        },
        read,
      }),
    async [Symbol.asyncDispose]() {
      await db.close();
    },
  };
}

Deno.test("history filters in PGlite before pagination across thousands of hidden messages", async () => {
  await using f = await fixture(Array.from({ length: 2_010 }, (_, i) => ({
    id: `m${String(i).padStart(4, "0")}`,
    visibility: i % 500 === 0
      ? { kind: "public" }
      : { kind: "participants", participantIds: ["other"] },
  })));
  assertEquals((await f.select({ order: "desc", limit: 2 })).map((r) => r.id), [
    "m2000",
    "m1500",
  ]);
  assertEquals(f.pages.length, 1);
  assertEquals(f.pages[0].limit, 2);
  assertEquals(
    (await f.select({ order: "desc", after: "m1500", limit: 2 })).map((r) =>
      r.id
    ),
    ["m1000", "m0500"],
  );
  assertEquals(
    (await f.select({ order: "desc", after: "m0500", limit: 2 })).map((r) =>
      r.id
    ),
    ["m0000"],
  );
  assertEquals(
    (await f.select({ order: "asc", before: "m1500", limit: 2 })).map((r) =>
      r.id
    ),
    ["m0000", "m0500"],
  );
  await assertRejects(
    () => Promise.resolve(f.select({ after: "m1501" })),
    RangeError,
  );
  await assertRejects(
    () => Promise.resolve(f.select({ after: "missing" })),
    RangeError,
  );
});

Deno.test("history preserves legacy scope, participant and requester visibility and redacts public status", async () => {
  const tool = (id: string, policy: string) => ({
    id,
    content: [{ assetId: "secret" }],
    visibility: { kind: "tool", policy, requesterId: "agent" },
    metadata: {
      toolStatus: "completed",
      toolId: "search",
      toolInvocation: { id: "call", input: "secret" },
      private: "secret",
    },
  });
  await using f = await fixture([
    { id: "legacy" },
    { id: "blank", historyScopeId: " \t\u00a0" },
    { id: "scoped", historyScopeId: "private" },
    { id: "internal", visibility: { kind: "internal" } },
    {
      id: "member",
      visibility: { kind: "participants", participantIds: ["human"] },
    },
    {
      id: "outsider",
      visibility: { kind: "participants", participantIds: ["other"] },
    },
    tool("status", "public_status"),
    tool("private", "requester_only"),
    tool("public", "public"),
    { id: "other-thread", threadId: "other" },
    { id: "other-tenant", namespace: "other" },
  ]);
  const result = await f.select();
  assertEquals(result.map((r) => r.id), [
    "legacy",
    "blank",
    "member",
    "status",
    "public",
  ]);
  const status = result.find((r) => r.id === "status")!;
  assertEquals(status.content, []);
  assertEquals(
    (status.metadata as Record<string, unknown>).toolStatus,
    "completed",
  );
  assertEquals(JSON.stringify(status).includes("secret"), false);
  assertEquals((await f.select({ messageId: "status" }))[0].content, []);
  assertEquals(await f.select({ messageId: "private" }), []);
  assertEquals(await f.select({ messageId: "other-tenant" }), []);
  assertEquals(
    (await f.select({ viewerParticipantIds: ["agent"] })).map((r) => r.id),
    ["legacy", "blank", "status", "private", "public"],
  );
  assertEquals(
    (await f.select({ viewerParticipantIds: [] })).map((r) => r.id),
    ["legacy", "blank", "status", "public"],
  );
  for (
    const after of [
      "scoped",
      "internal",
      "outsider",
      "other-thread",
      "other-tenant",
    ]
  ) {
    await assertRejects(() => Promise.resolve(f.select({ after })), RangeError);
  }
});

Deno.test("history filters active revision branches with timestamp ties and validates cursors in the selected view", async () => {
  const records = ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    createdAt: "2026-09-06T00:00:00.123456Z",
  }));
  await using f = await fixture(records, {
    rootMessageId: "b",
    headMessageId: "d",
  });
  assertEquals((await f.select()).map((r) => r.id), ["a", "d", "e"]);
  assertEquals((await f.select({ view: "all" })).map((r) => r.id), [
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  assertEquals(await f.select({ messageId: "b" }), []);
  await assertRejects(
    () => Promise.resolve(f.select({ after: "c" })),
    RangeError,
  );
  assertEquals((await f.select({ view: "all", after: "c" })).map((r) => r.id), [
    "d",
    "e",
  ]);
});

Deno.test("history retains the 1001 overfetch bound without scanning discarded rows", async () => {
  await using f = await fixture(
    Array.from({ length: 1_006 }, (_, i) => ({ id: `m${i}` })),
  );
  assertEquals((await f.select({ limit: 1001 })).length, 1001);
  assertEquals(f.pages.map((p) => p.limit), [1000, 1]);
  assertEquals((await f.select({ limit: 1001, content: true })).length, 1001);
});

Deno.test("history resolves only the selected page through runtime content options", async () => {
  const ref = {
    assetId: "body",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
  };
  await using f = await fixture([
    { id: "visible", content: [ref] },
    {
      id: "hidden",
      content: [{ ...ref, assetId: "missing-private" }],
      visibility: { kind: "participants", participantIds: ["other"] },
    },
    { id: "later", content: [{ ...ref, assetId: "missing-later" }] },
  ]);
  // The memory repository's explicit identity keeps the persisted reference unchanged.
  const asset = await f.assets.publish({
    namespace: "tenant",
    id: "body",
    mediaType: "text/plain",
    body: new TextEncoder().encode("Hello"),
  });
  assertEquals(asset.id, "body");
  assertEquals((await f.select({ limit: 1 }))[0].content, [ref]);
  assertEquals(f.assetReads, []);
  assertEquals((await f.select({ limit: 1, content: true }))[0].content, [{
    ...ref,
    value: "Hello",
  }]);
  assertEquals(f.assetReads, ["body"]);
  assertEquals(
    (await f.select({
      messageId: "visible",
      content: { fields: ["content"] },
    }))[0].content,
    [{ ...ref, value: "Hello" }],
  );
  const lookahead = await f.select({
    limit: 1,
    overfetch: true,
    content: true,
  });
  assertEquals(lookahead.map((record) => record.id), ["visible", "later"]);
  assertEquals(lookahead[1].content, [{ ...ref, assetId: "missing-later" }]);
  assertEquals(await f.select({ messageId: "hidden", content: true }), []);
  await assertRejects(
    () =>
      Promise.resolve(
        f.select({ limit: 1, content: { fields: ["metadata"] } }),
      ),
    TypeError,
    "Undeclared content field",
  );
});

Deno.test("resolved history never reads public-status result or reasoning assets", async () => {
  const ref = {
    assetId: "missing-private",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
  };
  await using f = await fixture([
    {
      id: "status",
      content: [ref],
      metadata: { llmReasoning: [ref], toolStatus: "completed" },
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "other",
      },
    },
  ]);
  for (const input of [{ limit: 1 }, { messageId: "status" }]) {
    const result = await f.select({ ...input, content: true });
    assertEquals(result.length, 1);
    assertEquals(result[0].content, []);
    assertEquals(
      (result[0].metadata as Record<string, unknown>).llmReasoning,
      undefined,
    );
  }
  assertEquals(f.assetReads, []);
});

Deno.test("history repeats visibility checks before resolving a concurrently restricted message", async () => {
  await using f = await fixture([{
    id: "changing",
    content: [{
      assetId: "never-read",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
  }]);
  f.beforeResolve(() =>
    f.patch("changing", {
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "other",
      },
    })
  );
  await assertRejects(
    () => Promise.resolve(f.select({ content: true })),
    Error,
    "changed during content preparation",
  );
  assertEquals(f.assetReads, []);
});

Deno.test("history exposes only terminal status for a private result of a visible invocation", async () => {
  await using f = await fixture([
    {
      id: "plan",
      senderId: "agent",
      visibility: { kind: "public" },
      metadata: {
        llmToolCalls: [{ id: "call", action: "consolidate_memory", input: {} }],
      },
    },
    {
      id: "private-result",
      senderId: "tool",
      visibility: {
        kind: "tool",
        policy: "requester_only",
        requesterId: "agent",
      },
      metadata: {
        toolStatus: "completed",
        toolId: "consolidate_memory",
        toolInvocation: { id: "call", input: "SECRET" },
        copilotzWorkflow: { sourceMessageId: "plan" },
        private: "SECRET",
      },
    },
  ]);
  const page = await f.select({
    order: "desc",
    limit: 1,
    overfetch: true,
    content: true,
  });
  assertEquals(page.map((r) => r.id), ["private-result", "plan"]);
  assertEquals(page[0].content, []);
  assertEquals(
    (page[0].metadata as Record<string, unknown>).toolStatus,
    "completed",
  );
  assertEquals(JSON.stringify(page[0]).includes("SECRET"), false);
  assertEquals(
    (await f.select({ after: "private-result", order: "desc", limit: 1 })).map(
      (r) => r.id,
    ),
    ["plan"],
  );
  const exact = await f.select({ messageId: "private-result", content: true });
  assertEquals(exact, [page[0]]);
  const requester = await f.select({
    messageId: "private-result",
    viewerParticipantIds: ["agent"],
  });
  assertEquals(
    (requester[0].metadata as Record<string, unknown>).private,
    "SECRET",
  );
});

Deno.test("history never reveals private tool statuses without an authorized matching source", async () => {
  const result = (
    id: string,
    source: string,
    call = "call",
    requester = "agent",
  ) => ({
    id,
    senderId: "tool",
    visibility: {
      kind: "tool",
      policy: "requester_only",
      requesterId: requester,
    },
    metadata: {
      toolStatus: "failed",
      toolId: "private",
      toolInvocation: { id: call },
      copilotzWorkflow: { sourceMessageId: source },
      error: "SECRET",
    },
  });
  await using f = await fixture([
    {
      id: "public-plan",
      senderId: "agent",
      visibility: { kind: "public" },
      metadata: { llmToolCalls: [{ id: "call" }] },
    },
    {
      id: "private-plan",
      senderId: "agent",
      visibility: { kind: "internal" },
      metadata: { llmToolCalls: [{ id: "call" }] },
    },
    result("hidden", "private-plan"),
    result("missing", "missing-plan"),
    result("wrong-call", "public-plan", "other"),
    result("wrong-owner", "public-plan", "call", "other"),
    {
      ...result("internal-result", "public-plan"),
      visibility: { kind: "internal" },
    },
    result("malformed", "public-plan", null as unknown as string),
  ]);
  assertEquals(
    (await f.select({
      order: "desc",
      limit: 1,
      overfetch: true,
      content: true,
    })).map((r) => r.id),
    ["public-plan"],
  );
  assertEquals(await f.select({ messageId: "hidden" }), []);
});

Deno.test("private terminal status recovery never resolves private assets", async () => {
  const ref = {
    assetId: "never-read",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
  };
  await using f = await fixture([
    {
      id: "plan",
      senderId: "agent",
      metadata: { llmToolCalls: [{ id: "call" }] },
    },
    {
      id: "result",
      content: [ref],
      visibility: {
        kind: "tool",
        policy: "requester_only",
        requesterId: "agent",
      },
      metadata: {
        toolStatus: "failed",
        llmReasoning: [ref],
        toolInvocation: { id: "call" },
        copilotzWorkflow: { sourceMessageId: "plan" },
      },
    },
  ]);
  for (const input of [{ limit: 2 }, { messageId: "result" }]) {
    const rows = await f.select({ ...input, content: true });
    const result = rows.find((row) => row.id === "result")!;
    assertEquals(result.content, []);
    assertEquals(
      (result.metadata as Record<string, unknown>).toolStatus,
      "failed",
    );
    assertEquals(
      (result.metadata as Record<string, unknown>).llmReasoning,
      undefined,
    );
  }
  assertEquals(f.assetReads, []);
});
