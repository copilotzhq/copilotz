import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../../../../runtime/testing/ominipg.ts";
import { createSqlSession } from "../../../../../runtime/events/index.ts";
import { queryCollectionRecords } from "../../../../../runtime/collections/query.ts";
import { createResolvedCollectionReader } from "../../../../../runtime/collections/resolved-read.ts";
import {
  createContentResolver,
  createMemoryAssetRepository,
} from "../../../../../runtime/content/index.ts";
import type {
  CollectionQuery,
  CollectionRecord,
  ScopedCollection,
} from "../../../../../runtime/collections/index.ts";
import { messageCollection } from "../../../collections/message/index.ts";
import {
  loadThreadMessageRecordWindow,
  mapMessageRecord,
  threadMessageRecordInWindow,
  threadMessageWindowFilter,
} from "../../../shared/projections.ts";
import type { Participant } from "../../../shared/contracts.ts";
import type { CoreProcessorContext } from "../../../shared/runtime-context.ts";
import { prepareLlmTranscript } from "../../../shared/agents/prepared-transcript.ts";

const date = "2026-09-06T00:00:00.000Z";
Deno.test("Core resolves own native reasoning, leaves peer state unread, and counts it in the byte limit", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const assets = createMemoryAssetRepository();
  const readIds: string[] = [];
  const resolver = createContentResolver({
    assets,
    authorize: ({ ref }) => {
      readIds.push(ref.assetId);
      return true;
    },
  });
  const publish = async (
    id: string,
    text: string,
    kind: "text" | "json" = "text",
    mediaType = "text/plain",
  ) => {
    await assets.publish({
      namespace: "tenant",
      id,
      mediaType,
      body: new TextEncoder().encode(text),
    });
    return {
      assetId: id,
      kind,
      role: "body",
      mediaType,
    };
  };
  try {
    const body = await publish("body", "visible");
    const reasoning = await publish("reasoning", "own previous thought");
    const native = await publish(
      "native",
      JSON.stringify({ opaque: "x".repeat(80) }),
      "json",
      "application/json",
    );
    const missing = { ...body, assetId: "must-not-read" };
    const missingNative = { ...native, assetId: "native-must-not-read" };
    const records = [
      {
        id: "north-message",
        senderId: "north",
        content: [body],
        metadata: {
          llmReasoning: [reasoning],
          llmNativeReasoning: {
            schema: "copilotz.llm-native-reasoning.v1",
            adapter: "adapter",
            api: "provider.api",
            model: "model",
            blocks: [native],
          },
        },
      },
      {
        id: "east-message",
        senderId: "east",
        content: [body],
        metadata: {
          llmReasoning: [missing],
          llmNativeReasoning: {
            schema: "copilotz.llm-native-reasoning.v1",
            adapter: "adapter",
            api: "provider.api",
            model: "model",
            blocks: [missingNative],
          },
        },
      },
      {
        id: "private-tool",
        senderId: "tool",
        content: [missing],
        metadata: {
          historyVisibility: "requester_only",
          requesterId: "east",
          toolInvocation: { id: "call" },
        },
      },
      {
        id: "human-message",
        senderId: "human",
        content: [body, { ...missing, disposition: "attachment" }],
        metadata: {},
      },
    ].map((record) => ({
      ...record,
      namespace: "tenant",
      threadId: "thread",
      createdAt: date,
      updatedAt: date,
    })) as CollectionRecord[];
    await session.query(
      "CREATE TABLE transcript_nodes (id text,namespace text,type text,data jsonb,created_at timestamptz,updated_at timestamptz,content text)",
    );
    await session.query(
      "INSERT INTO transcript_nodes SELECT r->>'id','tenant','message',r,$2::timestamptz,$2::timestamptz,'' FROM jsonb_array_elements($1::jsonb) r",
      [JSON.stringify(records), date],
    );
    const queries: CollectionQuery[] = [];
    const list = createResolvedCollectionReader(
      (query: CollectionQuery) => {
        queries.push(query);
        return queryCollectionRecords(
          session,
          { nodes: "transcript_nodes", edges: "unused" },
          messageCollection,
          "tenant",
          query,
        );
      },
      messageCollection,
      "tenant",
      resolver,
    );
    const context = {
      collections: { message: { list } as unknown as ScopedCollection },
    } as unknown as CoreProcessorContext;
    const history = records.map((record) =>
      mapMessageRecord(record, {
        id: String(record.senderId),
        namespace: "tenant",
        externalId: String(record.senderId),
        participantType: record.senderId === "tool"
          ? "tool"
          : record.senderId === "human"
          ? "human"
          : "agent",
        metadata: {},
        createdAt: date,
        updatedAt: date,
      } as Participant)
    );
    const transcript = await prepareLlmTranscript(context, {
      threadId: "thread",
      participantId: "north",
      history,
    });
    assertEquals(transcript.length, 3);
    assertEquals(transcript[0].role, "assistant");
    if (transcript[0].role === "assistant") {
      assertEquals(transcript[0].reasoning, [{
        ...reasoning,
        value: "own previous thought",
      }]);
      assertEquals<unknown>(transcript[0].nativeReasoning, {
        schema: "copilotz.llm-native-reasoning.v1",
        adapter: "adapter",
        api: "provider.api",
        model: "model",
        blocks: [{ ...native, value: { opaque: "x".repeat(80) } }],
      });
    }
    assertEquals("reasoning" in transcript[1], false);
    assertEquals("nativeReasoning" in transcript[1], false);
    assertEquals(transcript[2].content[1], {
      ...missing,
      disposition: "attachment",
      resolve: false,
    });
    assertEquals(readIds.includes("must-not-read"), false);
    assertEquals(readIds.includes("native-must-not-read"), false);
    assertEquals(queries.length, 2);
    await assertRejects(
      () =>
        prepareLlmTranscript(context, {
          threadId: "thread",
          participantId: "north",
          history,
        }, { byteLimit: 41 }),
      RangeError,
      "byte budget",
    );
    const queriesAfterByteLimit = queries.length;
    const empty = await prepareLlmTranscript(context, {
      threadId: "thread",
      participantId: "north",
      history,
      messageIds: [],
    });
    assertEquals(empty, []);
    assertEquals(queries.length, queriesAfterByteLimit);
  } finally {
    await db.close();
  }
});

Deno.test("Core rejects a changed content or visibility snapshot before opening asset bodies", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const assets = createMemoryAssetRepository();
  const readIds: string[] = [];
  const resolver = createContentResolver({
    assets,
    authorize: ({ ref }) => {
      readIds.push(ref.assetId);
      return true;
    },
  });
  const publish = async (id: string) => {
    await assets.publish({
      namespace: "tenant",
      id,
      mediaType: "text/plain",
      body: new TextEncoder().encode(id),
    });
    return {
      assetId: id,
      kind: "text" as const,
      role: "body",
      mediaType: "text/plain",
    };
  };
  try {
    const body = await publish("before");
    const changed = await publish("after");
    const record = {
      id: "message",
      namespace: "tenant",
      threadId: "thread",
      senderId: "north",
      content: [body],
      metadata: {},
      visibility: { kind: "public" },
      createdAt: date,
      updatedAt: date,
    } as CollectionRecord;
    await session.query(
      "CREATE TABLE changed_nodes (id text,namespace text,type text,data jsonb,created_at timestamptz,updated_at timestamptz,content text)",
    );
    await session.query(
      "INSERT INTO changed_nodes VALUES ('message','tenant','message',$1::jsonb,$2::timestamptz,$2::timestamptz,'')",
      [JSON.stringify(record), date],
    );
    let mutated = false;
    const list = createResolvedCollectionReader(
      async (query: CollectionQuery) => {
        if (!mutated) {
          mutated = true;
          await session.query(
            "UPDATE changed_nodes SET data = jsonb_set(jsonb_set(data, '{content}', $1::jsonb), '{visibility}', $2::jsonb)",
            [JSON.stringify([changed]), JSON.stringify({ kind: "internal" })],
          );
        }
        return await queryCollectionRecords(
          session,
          { nodes: "changed_nodes", edges: "unused" },
          messageCollection,
          "tenant",
          query,
        );
      },
      messageCollection,
      "tenant",
      resolver,
    );
    const participant = {
      id: "north",
      namespace: "tenant",
      externalId: "north",
      participantType: "agent" as const,
      metadata: {},
      createdAt: date,
      updatedAt: date,
    };
    const history = [{
      ...mapMessageRecord(record, participant),
      visibility: record.visibility as Record<string, unknown>,
    }];
    const context = {
      collections: { message: { list } as unknown as ScopedCollection },
    } as unknown as CoreProcessorContext;
    await assertRejects(
      () =>
        prepareLlmTranscript(context, {
          threadId: "thread",
          participantId: "north",
          history,
        }),
      Error,
      "no longer available",
    );
    assertEquals(readIds, []);
  } finally {
    await db.close();
  }
});

Deno.test("Agent window predicates select private scope, branch and anchor before PGlite pagination", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    const records = Array.from({ length: 2005 }, (_, index) => ({
      id: `m${String(index).padStart(4, "0")}`,
      namespace: "tenant",
      threadId: "thread",
      createdAt: new Date(index * 1000).toISOString(),
      updatedAt: new Date(index * 1000).toISOString(),
      ...(index % 500 === 0 ? { visibility: { kind: "public" } } : {
        visibility: { kind: "internal" },
        historyScopeId: index % 333 === 0 ? " \tscope\u00a0" : "other",
      }),
    })) as CollectionRecord[];
    await session.query(
      "CREATE TABLE window_nodes (id text,namespace text,type text,data jsonb,created_at timestamptz,updated_at timestamptz,content text)",
    );
    await session.query(
      "INSERT INTO window_nodes SELECT r->>'id','tenant','message',r,(r->>'createdAt')::timestamptz,(r->>'createdAt')::timestamptz,'' FROM jsonb_array_elements($1::jsonb) r",
      [JSON.stringify(records)],
    );
    const window = {
      threadRecord: { id: "thread", namespace: "tenant" } as CollectionRecord,
      records: [],
      participantRecords: [],
      anchorActive: true,
      anchor: records[2001],
      historyScopeId: "scope",
      branch: { root: records[1200], head: records[1800] },
    };
    const query = {
      filter: threadMessageWindowFilter(window),
      order: { field: "createdAt" as const, direction: "desc" as const },
      limit: 3,
    };
    const page = await queryCollectionRecords(
      session,
      { nodes: "window_nodes", edges: "unused" },
      messageCollection,
      "tenant",
      query,
    );
    assertEquals(page.map((r) => r.id), ["m2000", "m1998", "m1000"]);
    const expected = records.filter((record) =>
      threadMessageRecordInWindow(window, record)
    ).reverse().map((r) => r.id);
    const all = await queryCollectionRecords(
      session,
      { nodes: "window_nodes", edges: "unused" },
      messageCollection,
      "tenant",
      { ...query, limit: 1000 },
    );
    assertEquals(all.map((r) => r.id), expected);
    const bounded = { ...window, from: records[1000], anchor: records[1998] };
    const range = await queryCollectionRecords(
      session,
      { nodes: "window_nodes", edges: "unused" },
      messageCollection,
      "tenant",
      { ...query, filter: threadMessageWindowFilter(bounded), limit: 1000 },
    );
    assertEquals(range.map((r) => r.id), ["m1998", "m1000"]);
    assertEquals(
      range.map((r) => r.id),
      records.filter((r) => threadMessageRecordInWindow(bounded, r)).reverse()
        .map((r) => r.id),
    );
    const privateAnchor = {
      ...records[2000],
      visibility: { kind: "participants", participantIds: ["west"] },
    };
    await session.query(
      "UPDATE window_nodes SET data = $1::jsonb WHERE id = $2",
      [JSON.stringify(privateAnchor), privateAnchor.id],
    );
    const authorizedWindow = await loadThreadMessageRecordWindow(
      {
        collections: {
          thread: { get: () => Promise.resolve(window.threadRecord) },
          participant: {
            get: () => Promise.resolve(null),
          },
          message: {
            get: ({ id }: { id: string }) =>
              Promise.resolve(id === privateAnchor.id ? privateAnchor : null),
            list: (query: CollectionQuery) =>
              queryCollectionRecords(
                session,
                { nodes: "window_nodes", edges: "unused" },
                messageCollection,
                "tenant",
                query,
              ),
          },
        },
      } as unknown as CoreProcessorContext,
      "thread",
      { anchor: privateAnchor, viewerIds: ["north"] },
    );
    assertEquals(authorizedWindow.anchorActive, false);
    assertEquals(authorizedWindow.records, []);
  } finally {
    await db.close();
  }
});
