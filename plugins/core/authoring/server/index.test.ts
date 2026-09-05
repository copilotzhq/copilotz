import { assertEquals, assertRejects } from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createServerPlugin } from "../../../server/index.ts";
import { createServerFacadeFetchHandler } from "../../../../server/facade.ts";
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "../../../../client/index.ts";
import { createCoreClient } from "../client/index.ts";
import { createCoreServerPlugin } from "./index.ts";
import { corePlugin } from "../../plugin.ts";
import type { LlmAdapter } from "../../../llm/index.ts";

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
      createCoreServerPlugin(),
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
              models: { generate: ["test"] },
              capabilities: { tools: [] },
            },
            support: {
              id: "support",
              name: "Support",
              role: "support",
              instructions: "Reply",
              models: { generate: ["test"] },
              capabilities: { tools: [] },
            },
          },
          models: { test: { adapter: "test", model: "test" } },
        },
        adapters: { llm: { test: adapter } },
      }),
      createServerPlugin({
        authenticate(request) {
          return {
            namespace: request.headers.get("x-tenant") ?? "tenant",
            actor: { id: request.headers.get("x-user") ?? "person" },
          };
        },
        authorize(_request, context) {
          return {
            operations: { metadata: { actorId: context.scope.actor!.id } },
          };
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
        content: answer.content,
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
      metadata: { llmReasoning: answer.content },
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
    assertEquals((await core.threads.messages(result.threadId)).data.length, 4);
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
