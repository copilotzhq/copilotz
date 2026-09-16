import { assertEquals, assertRejects } from "@std/assert";
import type {
  CollectionQuery,
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  withAgentAskResultMetadata,
  withCoreToolPlanMetadata,
  withCoreToolPlanResultMetadata,
} from "./workflow-metadata.ts";
import { loadCoreThreadMessageSnapshot } from "./helpers.ts";

const NAMESPACE = "tenant-history-window";
const THREAD_ID = "thread-history-window";

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
}

function message(index: number): CollectionRecord {
  const createdAt = timestamp(index);
  return Object.freeze({
    id: `message-${String(index).padStart(4, "0")}`,
    namespace: NAMESPACE,
    threadId: THREAD_ID,
    senderId: "human",
    recipientIds: ["agent"],
    content: [{
      assetId: `asset-${index}`,
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
    metadata: {},
    visibility: { kind: "public" },
    createdAt,
    updatedAt: createdAt,
  });
}

function fakeCollection(
  source: readonly CollectionRecord[],
  counts?: { gets: number; lists: number },
): ScopedCollection {
  const records = new Map(source.map((record) => [record.id, record]));
  return {
    get({ id }: Readonly<{ id: string }>) {
      if (counts) counts.gets++;
      return Promise.resolve(records.get(id) ?? null);
    },
    list(query: CollectionQuery = {}) {
      if (counts) counts.lists++;
      let selected = [...records.values()].filter((record) =>
        Object.entries(query.where ?? {}).every(([key, value]) =>
          record[key] === value
        )
      );
      selected.sort((left, right) => {
        const field = query.order?.field ?? "id";
        const compared =
          String(left[field]).localeCompare(String(right[field])) ||
          left.id.localeCompare(right.id);
        return query.order?.direction === "desc" ? -compared : compared;
      });
      const after = query.after
        ? selected.findIndex((record) => record.id === query.after)
        : -1;
      if (query.after) selected = selected.slice(after + 1);
      const before = query.before
        ? selected.findIndex((record) => record.id === query.before)
        : -1;
      if (query.before) selected = selected.slice(0, before);
      return Promise.resolve(Object.freeze(selected.slice(0, query.limit)));
    },
  } as unknown as ScopedCollection;
}

function testContext(
  messages: readonly CollectionRecord[],
  thread: CollectionRecord,
  counts?: Readonly<{
    messages: { gets: number; lists: number };
    participants: { gets: number; lists: number };
  }>,
): Pick<ProcessorContext, "collections"> {
  const participants = [
    {
      id: "human",
      namespace: NAMESPACE,
      externalId: "human",
      participantType: "human",
      metadata: {},
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
    },
    {
      id: "agent",
      namespace: NAMESPACE,
      externalId: "agent",
      participantType: "agent",
      metadata: {},
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
    },
    {
      id: "tool",
      namespace: NAMESPACE,
      externalId: "tool",
      participantType: "tool",
      metadata: {},
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
    },
  ] satisfies readonly CollectionRecord[];
  return {
    collections: {
      message: fakeCollection(messages, counts?.messages),
      participant: fakeCollection(participants, counts?.participants),
      thread: fakeCollection([thread]),
    },
  } as unknown as Pick<ProcessorContext, "collections">;
}

Deno.test("Core history selects all authorized records while validating its trigger", async () => {
  const records = Array.from({ length: 1_002 }, (_, index) => message(index));
  const planId = "plan-at-history-boundary";
  const planMessage = Object.freeze({
    ...records[1],
    senderId: "agent",
    metadata: withCoreToolPlanMetadata({}, {
      schema: CORE_TOOL_PLAN_METADATA_SCHEMA,
      planId,
      planSize: 1,
    }),
  });
  const resultId = await deriveWorkflowId("message", planId, "0", "result");
  const resultMessage = Object.freeze({
    ...records[2],
    id: resultId,
    senderId: "tool",
    metadata: withAgentAskResultMetadata(
      withCoreToolPlanResultMetadata({}, {
        schema: "copilotz.core.tool-plan-result.v1",
        resultKind: "pipeline_failure",
        origin: {
          schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
          planId,
          planMessageId: planMessage.id,
          planIndex: 0,
          stageIndex: 0,
          stageCount: 1,
          planSize: 1,
          toolCallId: "call-a",
          action: "ask",
          threadId: THREAD_ID,
          triggerMessageId: records[0]!.id,
          agentId: "agent",
          agentParticipantId: "agent",
          initiatorParticipantId: "human",
          availableToolIds: ["ask"],
          responseVisibility: { kind: "public" },
          parentLlmActionRunId: "llm-run-a",
        },
        failedStageIndex: 0,
        failedAction: "ask",
      }),
      {
        schema: "copilotz.ask-result.v1",
        askId: "ask-a",
        status: "completed",
        askedParticipantId: "human",
        askedAgentId: "human-agent",
        answerMessageId: records[0]!.id,
      },
    ),
  });
  records[1] = planMessage;
  records[2] = resultMessage;
  const thread = Object.freeze({
    id: THREAD_ID,
    namespace: NAMESPACE,
    participantIds: ["human", "agent", "tool"],
    status: "active",
    metadata: {},
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
  });
  const counts = {
    messages: { gets: 0, lists: 0 },
    participants: { gets: 0, lists: 0 },
  };

  const snapshot = await loadCoreThreadMessageSnapshot(
    testContext(records, thread, counts),
    THREAD_ID,
    records.at(-1)!,
  );

  assertEquals(snapshot.active, true);
  assertEquals(snapshot.records.length, 1_002);
  assertEquals(snapshot.records.slice(0, 3).map((record) => record.id), [
    records[0]!.id,
    planMessage.id,
    resultId,
  ]);
  assertEquals(snapshot.records.at(-1)?.id, records.at(-1)?.id);
  assertEquals(counts.messages.lists, 2);
  assertEquals(counts.participants.gets, 3);
});

Deno.test("Core history ignores a queued trigger superseded by the active branch", async () => {
  const records = Array.from({ length: 4 }, (_, index) => message(index));
  const thread = Object.freeze({
    id: THREAD_ID,
    namespace: NAMESPACE,
    participantIds: ["human", "agent"],
    status: "active",
    metadata: {},
    activeMessageBranch: {
      rootMessageId: records[1]!.id,
      headMessageId: records[3]!.id,
      previousRevisionMessageId: records[2]!.id,
      revisionIndex: 1,
    },
    createdAt: timestamp(0),
    updatedAt: timestamp(3),
  });

  const snapshot = await loadCoreThreadMessageSnapshot(
    testContext(records, thread),
    THREAD_ID,
    records[2]!,
  );

  assertEquals(snapshot.active, false);
  assertEquals(snapshot.records, []);
  assertEquals(snapshot.messages, []);
});

Deno.test("a delayed trigger before compaction still selects the latest authorized tail", async () => {
  const records = Array.from({ length: 6 }, (_, index) => message(index));
  const thread = {
    id: THREAD_ID,
    namespace: NAMESPACE,
    participantIds: ["human", "agent"],
    status: "active",
    metadata: {},
    createdAt: timestamp(0),
    updatedAt: timestamp(5),
  };
  const snapshot = await loadCoreThreadMessageSnapshot(
    testContext(records, thread),
    THREAD_ID,
    records[0],
    { afterMessageId: records[2].id },
  );
  assertEquals(snapshot.active, true);
  assertEquals(
    snapshot.records.map((item) => item.id),
    records.slice(3).map((item) => item.id),
  );
});

Deno.test("checkpoint snapshots read their inclusive range and reject missing endpoints", async () => {
  const records = Array.from({ length: 6 }, (_, index) => message(index));
  const thread = {
    id: THREAD_ID,
    namespace: NAMESPACE,
    participantIds: ["human", "agent"],
    status: "active",
    metadata: {},
    createdAt: timestamp(0),
    updatedAt: timestamp(5),
  };
  const context = testContext(records, thread);
  const snapshot = await loadCoreThreadMessageSnapshot(
    context,
    THREAD_ID,
    records[3],
    {
      range: { startMessageId: records[1].id, endMessageId: records[3].id },
    },
  );
  assertEquals(snapshot.active, true);
  assertEquals(
    snapshot.records.map((r) => r.id),
    records.slice(1, 4).map((r) => r.id),
  );
  await assertRejects(
    () =>
      loadCoreThreadMessageSnapshot(context, THREAD_ID, records[3], {
        range: { startMessageId: "deleted", endMessageId: records[3].id },
      }),
    Error,
    "Memory source range is no longer available",
  );
});
