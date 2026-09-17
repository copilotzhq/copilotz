import { defineServerFacade as fixtureServerFacade } from "@copilotz/copilotz/server";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals, assertRejects } from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../../runtime/testing/ominipg.ts";
import { serverPlugin } from "../../../../server/index.ts";
import { createServerFacadeFetchHandler } from "../../../../../server/facade.ts";
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "../../../../../client/index.ts";
import { createCoreClient } from "../../../../core/adapters/client/index.ts";
import { coreHttpAdapter, coreHttpPlugin } from "../../../index.ts";
import type { HttpHandlerContext } from "../../../../server/authoring/http-adapter/index.ts";
import { corePlugin } from "../../../../core/plugin.ts";
import type { LlmAdapter } from "../../../../llm/index.ts";

Deno.test("Core message history reads each unique sender once", async () => {
  const route = coreHttpAdapter.routes.find((value) =>
    value.id === "core.threads.messages"
  );
  if (!route || !("handler" in route) || !route.handler) {
    throw new Error("Core message history route is not available.");
  }
  const senderReads: string[] = [];
  const participants: Record<string, Record<string, unknown>> = {
    "sender-a": {
      id: "sender-a",
      namespace: "tenant",
      externalId: "sender-a",
      participantType: "human",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    "sender-b": {
      id: "sender-b",
      namespace: "tenant",
      externalId: "sender-b",
      participantType: "agent",
      agentId: "north",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const thread = {
    id: "thread-history",
    namespace: "tenant",
    participantIds: ["sender-a", "sender-b"],
  };
  const messages = [
    {
      id: "message-a1",
      namespace: "tenant",
      threadId: thread.id,
      senderId: "sender-a",
      recipientIds: [],
      content: [],
      metadata: {},
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
    {
      id: "message-a2",
      namespace: "tenant",
      threadId: thread.id,
      senderId: "sender-a",
      recipientIds: [],
      content: [],
      metadata: {},
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
    {
      id: "message-b1",
      namespace: "tenant",
      threadId: thread.id,
      senderId: "sender-b",
      recipientIds: [],
      content: [],
      metadata: {},
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    },
  ];
  const context = {
    request: new Request(
      "https://test/api/threads/thread-history/messages",
    ),
    endpoint: {},
    params: { id: thread.id },
    input: undefined,
    scope: { actor: { id: "viewer" } },
    constraints: {},
    read: {
      list: () => Promise.resolve([thread]),
      get: (_name: string, id: string) => {
        senderReads.push(id);
        return Promise.resolve(participants[id] ?? null);
      },
      query: () => Promise.resolve(messages),
      aggregate: () => Promise.resolve([]),
    },
    invoke: () => Promise.reject(new Error("Unexpected action invocation.")),
    content: {
      get: () => Promise.reject(new Error("Unexpected asset read.")),
    },
    operations: {
      checkpoint: (threadId: string) =>
        Promise.resolve(threadId === thread.id ? "checkpoint" : ""),
      observe: () => Promise.reject(new Error("Unexpected observation.")),
    },
  } as unknown as HttpHandlerContext;

  const response = await route.handler(context);
  assertEquals(response instanceof Response, true);
  const body = await (response as Response).json() as {
    data: { id: string; sender: { id: string } }[];
  };
  assertEquals(senderReads, ["sender-a", "sender-b"]);
  assertEquals(
    body.data.map((message) => [message.id, message.sender.id]),
    [
      ["message-a1", "sender-a"],
      ["message-a2", "sender-a"],
      ["message-b1", "sender-b"],
    ],
  );
});

Deno.test("Core round trip keeps stored history, actor identity, and multipart bytes", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const adapter: LlmAdapter = {
    call() {
      const bytes = new TextEncoder().encode("Hello 🌎");
      return {
        frames: new ReadableStream({
          start(controller) {
            for (const byte of bytes) {
              controller.enqueue({
                lane: "content",
                mediaType: "text/plain",
                bytes: new Uint8Array([byte]),
              });
            }
            controller.close();
          },
        }),
        result: Promise.resolve({
          content: { type: "text", text: "Hello 🌎", role: "body" },
          attempts: [{
            status: "completed",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }],
          finishReason: "stop",
        }),
      };
    },
  };
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant",
    databaseSchema: "core_http_contract",
    engine: { retryBaseMs: 0, random: () => 0 },
    plugins: [
      corePlugin,
      coreHttpPlugin,
      definePlugin({
        id: "test.model",
        version: "1",
        resources: {
          agents: {
            spare: {
              id: "spare",
              name: "Spare",
              role: "support",
              instructions: "Reply",
              models: { generate: [{ connection: "test", model: "test" }] },
              capabilities: { tools: [] },
            },
            support: {
              id: "support",
              name: "Support",
              role: "support",
              instructions: "Reply",
              models: { generate: [{ connection: "test", model: "test" }] },
              capabilities: { tools: [] },
            },
          },
          llmConnections: { test: { adapter: "test" } },
        },
        adapters: { llm: { test: adapter } },
      }),
      defineFixturePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: fixtureServerFacade({
              authenticate(request) {
                return {
                  namespace: request.headers.get("x-tenant") ?? "tenant",
                  actor: { id: request.headers.get("x-user") ?? "person" },
                };
              },
              authorize(_request, context) {
                return {
                  operations: {
                    metadata: { actorId: context.scope.actor!.id },
                  },
                };
              },
            }),
          },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const core = createCoreClient(client);
  try {
    const receipt = await core.threads.send({
      externalThreadId: "new",
      content: "Hi",
      recipientIds: ["support"],
    }, { idempotencyKey: "hello" });
    const collected: number[] = [];
    await client.operations.observe({
      operationIds: [receipt.operationId],
      onFrame(frame) {
        if (frame.kind === "stream-chunk") collected.push(...frame.bytes);
      },
    });
    assertEquals(
      new TextDecoder().decode(new Uint8Array(collected)),
      "Hello 🌎",
    );
    const result = await client.operations.result(receipt.operationId) as {
      threadId: string;
    };
    const page = await core.threads.messages(result.threadId);
    assertEquals(page.data.length, 2);
    assertEquals(page.data[0].sender.id, "person");
    assertEquals(typeof page.pageInfo.checkpoint, "string");
    assertEquals((await core.threads.list()).data.length, 1);
    // Finish a follow-up entirely between the history read and live attachment.
    const followup = await core.threads.send({
      threadId: result.threadId,
      content: "Again",
      recipientIds: ["support"],
    }, { idempotencyKey: "followup" });
    await client.operations.observe({
      operationIds: [followup.operationId],
      onFrame() {},
    });
    const replayed: number[] = [];
    const streamOperations = new Map<string, string>();
    const disconnect = new AbortController();
    let completed = false;
    await core.threads.observe(result.threadId, {
      checkpoint: page.pageInfo.checkpoint,
      signal: disconnect.signal,
      onFrame(frame) {
        if (frame.kind === "output" && frame.output.type === "stream.output") {
          streamOperations.set(
            String(frame.output.streamId),
            String(frame.output.operationId),
          );
        }
        if (
          frame.kind === "stream-chunk" &&
          streamOperations.get(frame.streamId) === followup.operationId
        ) replayed.push(...frame.bytes);
        if (
          frame.kind === "output" &&
          frame.output.type === "operation.completed" &&
          frame.output.operationId === followup.operationId
        ) {
          completed = true;
          disconnect.abort();
        }
      },
    }).catch((error) => {
      if (!disconnect.signal.aborted) throw error;
    });
    assertEquals(completed, true);
    assertEquals(
      new TextDecoder().decode(new Uint8Array(replayed)),
      "Hello 🌎",
    );
    assertEquals(
      (await core.threads.list({ limit: 1 })).pageInfo.hasMore,
      false,
    );
    const firstPage = await core.threads.messages(result.threadId, {
      limit: 2,
    });
    const secondPage = await core.threads.messages(result.threadId, {
      limit: 2,
      after: firstPage.pageInfo.next,
    });
    assertEquals(firstPage.pageInfo.hasMore, true);
    assertEquals(secondPage.pageInfo.hasMore, false);
    assertEquals(
      new Set(
        [...firstPage.data, ...secondPage.data].map((message) => message.id),
      ).size,
      4,
    );
    const forbidden = await handler(
      new Request(`https://test/api/threads/${result.threadId}`, {
        headers: { "x-user": "outsider" },
      }),
    );
    assertEquals(forbidden.status, 404);
    const forgedOperation = await handler(
      new Request(`https://test/api/operations/${receipt.operationId}`, {
        headers: { "x-user": "outsider" },
      }),
    );
    assertEquals(forgedOperation.status, 404);
    const records = application.collections.withScope({ namespace: "tenant" });
    await records.participant.create({
      id: "foreign-human",
      externalId: "foreign-human",
      participantType: "human",
    });
    await records.participant.create({
      id: "test-tool",
      externalId: "test-tool",
      participantType: "tool",
    });
    const retainedContent =
      (await records.message.get({ id: page.data[1].id }))!.content;
    assertEquals(page.data[1].content[0].value, "Hello 🌎");
    await records.message.create({
      id: "status-result",
      threadId: result.threadId,
      senderId: "test-tool",
      recipientIds: [],
      content: retainedContent,
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "support",
      },
      metadata: {
        toolStatus: "completed",
        toolId: "test-tool",
        toolInvocation: { id: "call", input: "private-input" },
        copilotzWorkflow: { sourceMessageId: "plan" },
      },
    });
    const status = (await core.threads.messages(result.threadId)).data.find(
      (message) => message.id === "status-result",
    )!;
    assertEquals(status.metadata.toolStatus, "completed");
    assertEquals(status.content, []);
    assertEquals(JSON.stringify(status).includes("private-input"), false);
    await assertRejects(
      () =>
        core.messages.asset(
          result.threadId,
          status.id,
          page.data[1].content[0].assetId,
        ),
      CopilotzHttpError,
    );
    // Membership cannot invite a human from another thread, or partially enroll
    // valid selections before rejecting a forged selection.
    const answer = page.data[1];
    const assetId = answer.content[0].assetId;
    assertEquals(
      await (await core.messages.asset(result.threadId, answer.id, assetId))
        .text(),
      "Hello 🌎",
    );
    const assetPath = `/threads/${
      encodeURIComponent(result.threadId)
    }/messages/${encodeURIComponent(answer.id)}/assets/${
      encodeURIComponent(assetId)
    }`;
    for (
      const headers of [{ "x-user": "outsider" }, {
        "x-tenant": "other",
      }] as Record<string, string>[]
    ) {
      assertEquals(
        (await handler(
          new Request(`https://test/api${assetPath}`, { headers }),
        )).status,
        404,
      );
    }
    for (
      const [threadId, messageId, id] of [
        [result.threadId, answer.id, page.data[0].content[0].assetId],
        [result.threadId, "missing", assetId],
        ["wrong-thread", answer.id, assetId],
      ]
    ) {
      await assertRejects(
        () => core.messages.asset(threadId, messageId, id),
        CopilotzHttpError,
      );
    }
    // Reasoning and binary attachments use the same exact canonical references.
    const binary = await client.assets.upload(new Uint8Array([0, 255, 128]), {
      mediaType: "application/octet-stream",
    }) as { data: { asset: { id: string }; content: Record<string, unknown> } };
    const hidden = [
      {
        id: "private",
        visibility: { kind: "participants", participantIds: ["foreign-human"] },
      },
      { id: "internal", visibility: { kind: "internal" } },
      { id: "scoped", historyScopeId: "agent-private-turn" },
    ];
    for (const extra of hidden) {
      await records.message.create({
        threadId: result.threadId,
        senderId: "person",
        content: retainedContent,
        ...extra,
      });
      await assertRejects(
        () => core.messages.asset(result.threadId, extra.id, assetId),
        CopilotzHttpError,
      );
    }
    await records.message.create({
      id: "attachment",
      threadId: result.threadId,
      senderId: "person",
      content: [binary.data.content],
      metadata: { llmReasoning: retainedContent },
    });
    assertEquals([
      ...new Uint8Array(
        await (await core.messages.asset(
          result.threadId,
          "attachment",
          String(binary.data.content.assetId),
        )).arrayBuffer(),
      ),
    ], [0, 255, 128]);
    assertEquals(
      await (await core.messages.asset(result.threadId, "attachment", assetId))
        .text(),
      "Hello 🌎",
    );
    const visible = await core.threads.messages(result.threadId, {
      limit: 1,
      order: "desc",
    });
    assertEquals(visible.data[0].id, "attachment");
    assertEquals(
      visible.data[0].content[0].value,
      new Uint8Array([0, 255, 128]),
    );
    await records.message.delete({ id: "attachment" });
    await assertRejects(
      () => core.messages.asset(result.threadId, "attachment", assetId),
      CopilotzHttpError,
    );
    const before = await records.thread.get({ id: result.threadId });
    for (const participantIds of [["foreign-human"], ["spare", "unknown"]]) {
      const forbiddenMembership = await core.threads.send({
        threadId: result.threadId,
        content: "Do not enroll",
        participantIds,
        recipientIds: ["support"],
      }, { idempotencyKey: `members:${participantIds.join(":")}` });
      await assertRejects(
        () => client.operations.result(forbiddenMembership.operationId),
        CopilotzHttpError,
      );
      assertEquals(
        (await records.thread.get({ id: result.threadId }))?.participantIds,
        before?.participantIds,
      );
    }
    const rejected = await core.threads.send({
      threadId: result.threadId,
      content: "Do not deliver",
      recipientIds: ["foreign-human"],
    }, { idempotencyKey: "foreign-recipient" });
    await assertRejects(
      () => client.operations.result(rejected.operationId),
      CopilotzHttpError,
    );
    assertEquals((await core.threads.messages(result.threadId)).data.length, 5);
    assertEquals(
      ((await records.thread.get({ id: result.threadId }))
        ?.participantIds as string[]).includes("foreign-human"),
      false,
    );
  } finally {
    await application.close();
    await database.close();
  }
});
