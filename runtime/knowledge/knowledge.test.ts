import { coreFeatureAliases } from "@copilotz/copilotz/plugins/core";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../tools/index.ts";
import {
  createKnowledgePlugin,
  defineKnowledgeEmbeddingProvider,
} from "./index.ts";

const NAMESPACE = "tenant-knowledge";

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

function embeddingProvider(
  calls: Array<{
    texts: readonly string[];
    idempotencyKey: string;
    signal: AbortSignal;
  }>,
) {
  return defineKnowledgeEmbeddingProvider({
    id: "fixture.embedding",
    type: "embedding",
    embed(input) {
      calls.push({
        texts: input.texts,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      });
      return Promise.resolve({
        embeddings: input.texts.map((text) =>
          text.includes("unrelated") ? [0, 1] : [1, 0]
        ),
        model: input.model ?? "fixture-embedding-v1",
        dimensions: 2,
      });
    },
  });
}

async function createThread(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
): Promise<void> {
  await createTestDomainContext(application, NAMESPACE, coreFeatureAliases)
    .features.thread.create({
      id: "thread-a",
      participants: [{
        id: "human-a",
        externalId: "human-a",
        participantType: "human",
      }, {
        id: "agent-a",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
      }],
    }, { identity: { deduplicationId: "thread-a:create" } });
}

Deno.test("knowledge indexing keeps one canonical source asset and atomic searchable projections", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const calls: Array<{
    texts: readonly string[];
    idempotencyKey: string;
    signal: AbortSignal;
  }> = [];
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_knowledge",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createKnowledgePlugin({
      embedding: {
        provider: "fixture.embedding",
        dimensions: 2,
        batchSize: 2,
      },
      chunking: { chunkSize: 512, chunkOverlap: 0 },
    })],
    resources: { llm: [embeddingProvider(calls)] },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await createThread(application);
    const source =
      "Copilotz stores durable semantic content and retrieves it by meaning.";
    const created = await application.knowledge.create({
      namespace: NAMESPACE,
      id: "document-a",
      title: "Durable semantics",
      source: { kind: "content", content: `text:${source}`.slice(5) },
      threadId: "thread-a",
      requestedByParticipantId: "human-a",
      metadata: { scope: { threadId: "thread-a" } },
      identity: {
        correlationId: "knowledge-a",
        deduplicationId: "document-a:create",
      },
    });
    assertEquals(created.event.type, "document.created");
    assertEquals(created.dispatch.handles.length, 1);
    assertEquals(
      (await created.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );

    const document = await application.knowledge.get(
      NAMESPACE,
      "document-a",
    );
    assertExists(document);
    assertEquals(document.status, "indexed");
    assertEquals(document.chunkCount, 1);
    assertEquals(document.source.length, 1);
    assertEquals(document.source[0].role, "document.source");
    const resolved = await application.content.resolver.get(
      document.source[0],
      { namespace: NAMESPACE },
    );
    assertEquals(resolved.text, source);
    assertEquals(resolved.asset.digest, document.contentHash);

    const chunks = await application.knowledge.listChunks(
      NAMESPACE,
      document.id,
    );
    assertEquals(chunks.length, 1);
    assertStringIncludes(chunks[0].content, "Copilotz stores");
    assertEquals(chunks[0].embedding, [1, 0]);
    assertEquals(
      (await application.knowledge.search({
        namespace: NAMESPACE,
        embedding: [1, 0],
        scope: { threadId: "thread-a" },
        threshold: 0.5,
      })).map((result) => result.document.id),
      ["document-a"],
    );
    assertEquals(
      await application.knowledge.search({
        namespace: NAMESPACE,
        embedding: [1, 0],
        scope: { threadId: "another-thread" },
      }),
      [],
    );
    assertEquals(
      await application.knowledge.search({
        namespace: "another-tenant",
        embedding: [1, 0],
        scope: { threadId: "thread-a" },
      }),
      [],
    );

    const events = await application.events.list({ namespace: NAMESPACE });
    assertEquals(
      events.filter((event) => event.type === "document.created").length,
      1,
    );
    assertEquals(
      events.filter((event) => event.type === "document.processing").length,
      1,
    );
    assertEquals(
      events.filter((event) => event.type === "document.indexed").length,
      1,
    );
    assertEquals(events.some((event) => event.type === "chunk.created"), false);
    const deliveries = await application.deliveries.list({
      namespace: NAMESPACE,
      eventId: created.event.id,
    });
    assertEquals(deliveries.map((item) => item.status), ["succeeded"]);
    assert(calls.length > 0);
    assert(calls.every((call) => call.signal instanceof AbortSignal));
    assert(
      calls.every((call) => call.idempotencyKey.includes("knowledge-embed")),
    );

    const messages = await projectMessages(application, NAMESPACE, "thread-a");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].sender.participantType, "job");
    assertEquals(messages[0].recipientIds, []);
    const announcement = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertStringIncludes(announcement[0].text!, "Successfully indexed");

    const duplicate = await application.knowledge.create({
      namespace: NAMESPACE,
      id: "document-b",
      title: "Duplicate semantics",
      source: { kind: "content", content: source },
      threadId: "thread-a",
      identity: {
        correlationId: "knowledge-b",
        deduplicationId: "document-b:create",
      },
    });
    assertEquals(
      (await duplicate.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );
    const duplicateDocument = await application.knowledge.get(
      NAMESPACE,
      "document-b",
    );
    assertExists(duplicateDocument);
    assertEquals(duplicateDocument.status, "duplicate");
    assertEquals(duplicateDocument.duplicateOfDocumentId, "document-a");
    assertEquals(duplicateDocument.chunkCount, 0);
    assertEquals(duplicateDocument.source, document.source);

    const deleted = await application.knowledge.delete(
      NAMESPACE,
      document.id,
      {
        correlationId: "knowledge-delete-a",
        deduplicationId: "document-a:delete",
      },
    );
    assertEquals(deleted.value, { id: "document-a", deleted: true });
    assertEquals(await application.knowledge.get(NAMESPACE, document.id), null);
    assertEquals(
      await application.knowledge.listChunks(NAMESPACE, document.id),
      [],
    );
    assertExists(
      await application.content.assets.get(
        NAMESPACE,
        duplicateDocument.source[0].assetId,
      ),
    );
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).some((event) =>
        event.type === "document.indexed" && event.subject?.id === document.id
      ),
      true,
    );

    await assertRejects(
      () =>
        application.knowledge.create({
          namespace: NAMESPACE,
          id: "document-invalid",
          source: { kind: "content", content: "not persisted" },
          threadId: "missing-thread",
          identity: { deduplicationId: "document-invalid:create" },
        }),
      Error,
      "Thread 'missing-thread' was not found",
    );
    assertEquals(
      await application.knowledge.get(NAMESPACE, "document-invalid"),
      null,
    );
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).some((event) =>
        event.subject?.id === "document-invalid"
      ),
      false,
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("knowledge source failures retry through Oxian and settle as one durable failure", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const sourceKeys: string[] = [];
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_knowledge_failure",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createKnowledgePlugin({
      embedding: { provider: "fixture.embedding", dimensions: 2 },
      sourceLoader(input) {
        sourceKeys.push(input.idempotencyKey);
        return Promise.reject(new Error("fixture source unavailable"));
      },
    })],
    resources: { llm: [embeddingProvider([])] },
    engine: { retryBaseMs: 0, random: () => 0, maxAttempts: 3 },
  });
  try {
    await createThread(application);
    const created = await application.knowledge.create({
      namespace: NAMESPACE,
      id: "document-failure",
      title: "Unavailable source",
      source: { kind: "uri", uri: "https://example.test/unavailable" },
      threadId: "thread-a",
      identity: {
        correlationId: "knowledge-failure",
        deduplicationId: "document-failure:create",
      },
    });
    assertEquals(
      (await created.dispatch.handles[0].done).delivery.status,
      "retry_wait",
    );
    for (const expected of ["retry_wait", "dead_letter"] as const) {
      const recovery = await application.recover({ namespace: NAMESPACE });
      assertEquals(recovery.handles.length, 1);
      assertEquals(
        (await recovery.handles[0].done).delivery.status,
        expected,
      );
    }
    assertEquals(sourceKeys.length, 3);
    assertEquals(new Set(sourceKeys).size, 1);
    const document = await application.knowledge.get(
      NAMESPACE,
      "document-failure",
    );
    assertExists(document);
    assertEquals(document.status, "failed");
    assertEquals(document.error?.message, "fixture source unavailable");
    const events = await application.events.list({ namespace: NAMESPACE });
    assertEquals(
      events.filter((event) => event.type === "document.failed").length,
      1,
    );
    const messages = await projectMessages(application, NAMESPACE, "thread-a");
    assertEquals(messages.length, 1);
    const content = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertStringIncludes(content[0].text!, "Failed to ingest document");
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("knowledge tools execute through scoped factory capabilities", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const outputs = new Map<string, unknown>();
  const driver = defineProcessor<CopilotzProcessorContext>({
    id: "fixture.knowledge-tools",
    on: [{ eventType: "fixture.knowledge_tool.requested" }],
    async handle(event, processor) {
      if (!event.durable || !event.threadId) return;
      const payload = event.payload as {
        toolId: string;
        arguments: Record<string, unknown>;
      };
      const tool = processor.resources.require<WorkflowTool>(
        "tools",
        payload.toolId,
      );
      const timestamp = event.createdAt;
      const toolContext: WorkflowToolExecutionContext = {
        namespace: processor.namespace,
        correlationId: event.correlationId,
        idempotencyKey: processor.idempotencyKey,
        processor,
        execution: {
          id: `execution:${event.id}`,
          namespace: processor.namespace,
          threadId: event.threadId,
          participantId: "agent-a",
          agentId: "support",
          toolCallId: `call:${event.id}`,
          tool: { id: tool.id, key: tool.key },
          status: "running",
          content: [],
          startedAt: timestamp,
          metadata: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        threadId: event.threadId,
        toolExecutionId: `execution:${event.id}`,
        toolCallId: `call:${event.id}`,
        agents: [],
        tools: [tool],
        collections: processor.collections,
        emitOutput: () => Promise.resolve(),
        cancelled: false,
      };
      outputs.set(
        event.id,
        await tool.execute(payload.arguments, toolContext),
      );
    },
  });
  const driverPlugin = definePlugin({
    manifest: {
      id: "fixture.knowledge-tools",
      version: "1.0.0",
      provides: { processors: [driver.id] },
    },
    resources: { processors: [driver] },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_knowledge_tools",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [
      createKnowledgePlugin({
        embedding: { provider: "fixture.embedding", dimensions: 2 },
        chunking: { chunkSize: 512, chunkOverlap: 0 },
      }),
      driverPlugin,
    ],
    resources: { llm: [embeddingProvider([])] },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const invoke = async (
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const result = await application.events.append({
      type: "fixture.knowledge_tool.requested",
      namespace: NAMESPACE,
      threadId: "thread-a",
      payload: { toolId, arguments: args },
      correlationId: crypto.randomUUID(),
    });
    assertEquals(result.dispatch.handles.length, 1);
    assertEquals(
      (await result.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );
    return outputs.get(result.event.id) as Record<string, unknown>;
  };
  try {
    await createThread(application);
    const ingestion = await invoke("ingest_document", {
      source:
        "text:Workers keep semantic state durable and execution portable.",
      title: "Portable workers",
    });
    assertEquals(ingestion.status, "pending");
    const documentId = String(ingestion.documentId);
    await application.events.waitFor({
      namespace: NAMESPACE,
      types: ["document.indexed"],
      subject: { type: "document", id: documentId },
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    const search = await invoke("search_knowledge", {
      query: "How is worker state stored?",
      threshold: 0.5,
    });
    const results = search.results as Array<Record<string, unknown>>;
    assertEquals(results.length, 1);
    assertEquals(results[0].documentId, documentId);
    assertStringIncludes(String(results[0].content), "Workers keep");
    const deletion = await invoke("delete_document", { documentId });
    assertEquals(deletion.success, true);
    assertEquals(deletion.documentId, documentId);
    assertEquals(await application.knowledge.get(NAMESPACE, documentId), null);
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("knowledge modules remain factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "collections.ts",
      "index.ts",
      "plugin.ts",
      "repository.ts",
      "resources.ts",
      "source.ts",
      "tools.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/unsafeGraph|queueId|queueTTL|ackMode|runGeneration/.test(source));
  }
});
