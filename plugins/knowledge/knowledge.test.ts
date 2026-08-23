import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
} from "../../runtime/testing/projections.ts";

import { createCopilotz } from "@copilotz/copilotz/application";
import { createCopilotzApplication } from "../../runtime/application/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import { coreCollectionsPlugin } from "../core/plugin.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import {
  createDeleteDocumentTool,
  createIngestDocumentTool,
  createKnowledgePlugin,
  createSearchKnowledgeTool,
  defineKnowledgeEmbeddingProvider,
} from "./index.ts";
import type { KnowledgeActionCallers } from "./actions.ts";
import type { KnowledgeChunk, KnowledgeDocument } from "./types.ts";

const NAMESPACE = "tenant-knowledge";

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

type TestApplication = Awaited<ReturnType<typeof createCopilotzApplication>>;

async function knowledgeHarness(
  application: TestApplication,
  databaseSchema: string,
) {
  const scope = await application.databaseScope(databaseSchema);
  const collections = scope.collections.withScope({
    namespace: NAMESPACE,
  });
  const actionContext = createTestDomainContext(application, NAMESPACE);
  return Object.freeze({
    documents: collections.document,
    chunks: collections.chunk,
    actions: actionContext.actions as unknown as KnowledgeActionCallers,
    prepareSource(text: string, operationKey: string) {
      return scope.content.preparer.prepare({
        type: "text",
        text,
        role: "document.source",
      }, { namespace: NAMESPACE, idempotencyKey: operationKey });
    },
  });
}

async function waitForDocumentStatus(
  application: TestApplication,
  documentId: string,
  status: "indexed" | "duplicate" | "failed",
): Promise<void> {
  const eventType = status === "duplicate"
    ? "document.duplicate"
    : `document.${status}`;
  await application.events.waitFor({
    namespace: NAMESPACE,
    types: [eventType],
    subject: { type: "document", id: documentId },
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  });
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

Deno.test("knowledge plugin exposes keyed Collections, Actions, Processors, and Tool Resources", () => {
  const plugin = createKnowledgePlugin({
    embedding: { provider: "fixture.embedding" },
  });
  assertEquals(Object.keys(plugin.collections), ["document", "chunk"]);
  assertEquals(Object.keys(plugin.actions), [
    "indexKnowledgeDocument",
    "searchKnowledge",
    "deleteKnowledgeDocument",
  ]);
  assertEquals(
    Object.values(plugin.actions).map((action) => action.id),
    [
      "copilotz.knowledge.indexDocument",
      "copilotz.knowledge.searchDocuments",
      "copilotz.knowledge.deleteDocument",
    ],
  );
  assertEquals(Object.keys(plugin.processors), ["indexKnowledgeDocument"]);
  assertEquals(Object.keys(plugin.resources.tools), [
    "ingestKnowledge",
    "searchKnowledge",
    "deleteKnowledgeDocument",
  ]);
  assertEquals("features" in plugin, false);
});

async function createThread(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
): Promise<void> {
  await createTestDomainContext(application, NAMESPACE)
    .actions.createThread({
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

Deno.test("package root composes the explicit Knowledge plugin", async () => {
  const application = await createCopilotz({
    namespace: "knowledge-root",
    plugins: [
      coreCollectionsPlugin,
      createKnowledgePlugin({
        embedding: { provider: "fixture.embedding" },
      }),
    ],
    adapters: {
      embedding: {
        "fixture.embedding": embeddingProvider([]),
      },
    },
  });
  try {
    assert(application.plugins.collections.document);
    assert(application.plugins.collections.chunk);
    assertEquals("knowledge" in application, false);
    assertEquals(
      application.config.pluginIds.includes("@copilotz/knowledge"),
      true,
    );
  } finally {
    await application.shutdown();
  }
});

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
    plugins: [
      coreCollectionsPlugin,
      createKnowledgePlugin({
        embedding: {
          provider: "fixture.embedding",
          dimensions: 2,
          batchSize: 2,
        },
        chunking: { chunkSize: 512, chunkOverlap: 0 },
      }),
    ],
    adapters: {
      embedding: { "fixture.embedding": embeddingProvider(calls) },
    },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await createThread(application);
    const knowledge = await knowledgeHarness(
      application,
      "copilotz_v3_knowledge",
    );
    const source =
      "Copilotz stores durable semantic content and retrieves it by meaning.";
    const created = await knowledge.documents.create({
      id: "document-a",
      title: "Durable semantics",
      source: await knowledge.prepareSource(source, "document-a:source"),
      sourceType: "text",
      sourceUri: null,
      mediaType: null,
      contentHash: null,
      status: "pending",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId: "thread-a",
      requestedByParticipantId: "human-a",
      forceReindex: false,
      error: null,
      externalId: null,
      metadata: { scope: { threadId: "thread-a" } },
    }, {
      operationKey: "document-a:create",
      identity: { correlationId: "knowledge-a" },
    }) as KnowledgeDocument;
    assertEquals(created.status, "pending");
    await waitForDocumentStatus(application, "document-a", "indexed");

    const document = await knowledge.documents.get({ id: "document-a" }) as
      | KnowledgeDocument
      | null;
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

    const chunks = await knowledge.chunks.list({
      where: { documentId: document.id },
    }) as readonly KnowledgeChunk[];
    assertEquals(chunks.length, 1);
    assertStringIncludes(chunks[0].content, "Copilotz stores");
    assertEquals(chunks[0].embedding, [1, 0]);
    assertEquals(
      (await knowledge.actions.searchKnowledge({
        embedding: [1, 0],
        scope: { threadId: "thread-a" },
        threshold: 0.5,
      })).map((result) => result.document.id),
      ["document-a"],
    );
    assertEquals(
      await knowledge.actions.searchKnowledge({
        embedding: [1, 0],
        scope: { threadId: "another-thread" },
      }),
      [],
    );

    await application.events.waitFor({
      namespace: NAMESPACE,
      types: ["copilotz.knowledge.indexDocument.completed"],
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
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
    assertEquals(
      events.filter((event) => event.type === "chunk.created").length,
      1,
    );
    assertEquals(
      events.filter((event) =>
        event.type === "copilotz.knowledge.indexDocument.invoked"
      ).length,
      1,
    );
    assertEquals(
      events.filter((event) =>
        event.type === "copilotz.knowledge.indexDocument.completed"
      ).length,
      1,
    );
    const createdEvent = events.find((event) =>
      event.type === "document.created" && event.subject?.id === "document-a"
    );
    assertExists(createdEvent);
    let deliveries = await application.deliveries.list({
      namespace: NAMESPACE,
      eventId: createdEvent.id,
    });
    const deliveryDeadline = Date.now() + 5_000;
    while (
      deliveries.some((item) => item.status !== "succeeded") &&
      Date.now() < deliveryDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      deliveries = await application.deliveries.list({
        namespace: NAMESPACE,
        eventId: createdEvent.id,
      });
    }
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

    await knowledge.documents.create({
      id: "document-b",
      title: "Duplicate semantics",
      source: await knowledge.prepareSource(source, "document-b:source"),
      sourceType: "text",
      sourceUri: null,
      mediaType: null,
      contentHash: null,
      status: "pending",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId: "thread-a",
      requestedByParticipantId: null,
      forceReindex: false,
      error: null,
      externalId: null,
      metadata: {},
    }, {
      operationKey: "document-b:create",
      identity: { correlationId: "knowledge-b" },
    });
    await waitForDocumentStatus(application, "document-b", "duplicate");
    const duplicateDocument = await knowledge.documents.get({
      id: "document-b",
    }) as KnowledgeDocument | null;
    assertExists(duplicateDocument);
    assertEquals(duplicateDocument.status, "duplicate");
    assertEquals(duplicateDocument.duplicateOfDocumentId, "document-a");
    assertEquals(duplicateDocument.chunkCount, 0);
    assertEquals(duplicateDocument.source, document.source);

    const deleted = await knowledge.actions.deleteKnowledgeDocument({
      documentId: document.id,
    }, { operationKey: "document-a:delete" });
    assertEquals(deleted.success, true);
    if (!deleted.success) throw new Error(deleted.message);
    assertEquals(deleted.documentId, "document-a");
    assertEquals(await knowledge.documents.get({ id: document.id }), null);
    assertEquals(
      await knowledge.chunks.list({ where: { documentId: document.id } }),
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
      async () =>
        await knowledge.documents.create({
          id: "document-invalid",
          title: "Invalid",
          source: await knowledge.prepareSource(
            "not persisted",
            "document-invalid:source",
          ),
          sourceType: "text",
          sourceUri: null,
          mediaType: null,
          contentHash: null,
          status: "pending",
          chunkCount: 0,
          duplicateOfDocumentId: null,
          threadId: "missing-thread",
          requestedByParticipantId: null,
          forceReindex: false,
          error: null,
          externalId: null,
          metadata: {},
        }, { operationKey: "document-invalid:create" }),
      Error,
      "references missing thread 'missing-thread'",
    );
    assertEquals(
      await knowledge.documents.get({ id: "document-invalid" }),
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

Deno.test("knowledge source failure settles once as document and Action failure", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const sourceKeys: string[] = [];
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_knowledge_failure",
    plugins: [
      coreCollectionsPlugin,
      createKnowledgePlugin({
        embedding: { provider: "fixture.embedding", dimensions: 2 },
        sourceLoader(input) {
          sourceKeys.push(input.idempotencyKey);
          return Promise.reject(new Error("fixture source unavailable"));
        },
      }),
    ],
    adapters: {
      embedding: { "fixture.embedding": embeddingProvider([]) },
    },
    engine: { retryBaseMs: 0, random: () => 0, maxAttempts: 3 },
  });
  try {
    await createThread(application);
    const knowledge = await knowledgeHarness(
      application,
      "copilotz_v3_knowledge_failure",
    );
    await knowledge.documents.create({
      id: "document-failure",
      title: "Unavailable source",
      source: [],
      sourceType: "url",
      sourceUri: "https://example.test/unavailable",
      mediaType: null,
      contentHash: null,
      status: "pending",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId: "thread-a",
      requestedByParticipantId: null,
      forceReindex: false,
      error: null,
      externalId: null,
      metadata: {},
    }, {
      operationKey: "document-failure:create",
      identity: { correlationId: "knowledge-failure" },
    });
    await application.events.waitFor({
      namespace: NAMESPACE,
      types: ["copilotz.knowledge.indexDocument.failed"],
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    assertEquals(sourceKeys.length, 1);
    const document = await knowledge.documents.get({
      id: "document-failure",
    }) as KnowledgeDocument | null;
    assertExists(document);
    assertEquals(document.status, "failed");
    assertEquals(document.error?.message, "fixture source unavailable");
    const events = await application.events.list({ namespace: NAMESPACE });
    assertEquals(
      events.filter((event) => event.type === "document.failed").length,
      1,
    );
    assertEquals(
      events.filter((event) =>
        event.type === "copilotz.knowledge.indexDocument.failed"
      ).length,
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
  const driver = defineProcessor<ProcessorContext>({
    id: "fixture.knowledge-tools",
    on: [{ eventType: "fixture.knowledge_tool.requested" }],
    async handle(event, processor) {
      if (!event.durable || !event.threadId) return;
      const payload = event.payload as {
        toolId: string;
        arguments: Record<string, unknown>;
      };
      const tool = Object.values(processor.resources.tools ?? {}).find(
        (candidate) => (candidate as WorkflowTool).key === payload.toolId,
      ) as WorkflowTool | undefined;
      if (!tool) throw new Error(`Unknown tool '${payload.toolId}'.`);
      const toolContext: WorkflowToolExecutionContext = {
        namespace: processor.namespace,
        correlationId: event.correlationId,
        idempotencyKey: processor.operationKey,
        processor,
        execution: {
          id: `execution:${event.id}`,
          namespace: processor.namespace,
          threadId: event.threadId,
          participantId: "agent-a",
          agentId: "support",
          toolCallId: `call:${event.id}`,
          tool: { id: tool.id, key: tool.key },
          metadata: {},
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
    id: "fixture.knowledge-tools",
    version: "1.0.0",
    processors: { knowledgeTools: driver },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_knowledge_tools",
    plugins: [
      coreCollectionsPlugin,
      createKnowledgePlugin({
        embedding: { provider: "fixture.embedding", dimensions: 2 },
        chunking: { chunkSize: 512, chunkOverlap: 0 },
      }),
      driverPlugin,
    ],
    adapters: {
      embedding: { "fixture.embedding": embeddingProvider([]) },
    },
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
    const knowledge = await knowledgeHarness(
      application,
      "copilotz_v3_knowledge_tools",
    );
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
    assertEquals(await knowledge.documents.get({ id: documentId }), null);
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("knowledge ingest tool creates documents through collections without knowledge capability", async () => {
  const createdInputs: Record<string, unknown>[] = [];
  const tool = createIngestDocumentTool();
  const output = await tool.execute({
    source: "text:Collection-native ingestion",
    title: "Collection native",
    metadata: { scope: { documentIds: ["doc-a"] } },
  }, {
    namespace: NAMESPACE,
    idempotencyKey: "ingest-unit",
    correlationId: "ingest-unit",
    processor: {
      namespace: NAMESPACE,
      content: {
        prepare: async () =>
          Object.freeze({
            content: Object.freeze([{
              assetId: "asset-a",
              kind: "text",
              role: "document.source",
              mediaType: "text/plain",
            }]),
            assets: Object.freeze([]),
          }),
      },
      collections: {
        document: {
          queries: {
            byExternalId: async () => [],
          },
          async create(input: Record<string, unknown>) {
            createdInputs.push(input);
            return {
              ...input,
              namespace: NAMESPACE,
              createdAt: "2026-08-21T00:00:00.000Z",
              updatedAt: "2026-08-21T00:00:00.000Z",
            };
          },
        },
      },
    },
    execution: {
      id: "execution-a",
      namespace: NAMESPACE,
      threadId: "thread-a",
      participantId: "human-a",
      agentId: "support",
      toolCallId: "call-a",
      tool: { id: tool.id, key: tool.key },
      status: "running",
      content: [],
      startedAt: "2026-08-21T00:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    threadId: "thread-a",
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    agents: [],
    tools: [tool],
    collections: {},
    emitOutput: () => Promise.resolve(),
    cancelled: false,
  } as unknown as WorkflowToolExecutionContext) as Record<string, unknown>;

  assertEquals(output.documentId, "document:execution-a");
  assertEquals(output.title, "Collection native");
  assertEquals(createdInputs.length, 1);
  assertEquals(createdInputs[0].sourceType, "text");
  assertEquals(createdInputs[0].sourceUri, null);
  assertEquals(createdInputs[0].status, "pending");
  assertEquals(createdInputs[0].source, {
    content: [{
      assetId: "asset-a",
      kind: "text",
      role: "document.source",
      mediaType: "text/plain",
    }],
    assets: [],
  });
});

Deno.test("knowledge delete tool delegates to its Action alias", async () => {
  const tool = createDeleteDocumentTool();
  const calls: unknown[] = [];
  const output = await tool.execute({
    documentId: "document-a",
  }, {
    namespace: NAMESPACE,
    idempotencyKey: "delete-unit",
    correlationId: "delete-unit",
    processor: {
      signal: new AbortController().signal,
      actions: {
        async deleteKnowledgeDocument(input: unknown) {
          calls.push(input);
          return {
            success: true,
            message: "Document deleted.",
            documentId: "document-a",
            title: "Document A",
            namespace: NAMESPACE,
          };
        },
      },
    },
    execution: {
      id: "execution-delete",
      namespace: NAMESPACE,
      threadId: "thread-a",
      participantId: "human-a",
      agentId: "support",
      toolCallId: "call-delete",
      tool: { id: tool.id, key: tool.key },
      status: "running",
      content: [],
      startedAt: "2026-08-21T00:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    threadId: "thread-a",
    toolExecutionId: "execution-delete",
    toolCallId: "call-delete",
    agents: [],
    tools: [tool],
    collections: {},
    emitOutput: () => Promise.resolve(),
    cancelled: false,
  } as unknown as WorkflowToolExecutionContext) as Record<string, unknown>;

  assertEquals(calls, [{ documentId: "document-a" }]);
  assertEquals(output.success, true);
  assertEquals(output.documentId, "document-a");
});

Deno.test("knowledge search tool delegates to its Action alias", async () => {
  const tool = createSearchKnowledgeTool({
    provider: "fixture.embedding",
    dimensions: 2,
  });
  const calls: unknown[] = [];
  const embeddingCalls: unknown[] = [];
  const output = await tool.execute({
    query: "durable semantics",
    threshold: 0.5,
  }, {
    namespace: NAMESPACE,
    idempotencyKey: "search-unit",
    correlationId: "search-unit",
    processor: {
      signal: new AbortController().signal,
      adapters: {
        embedding: {
          "fixture.embedding": defineKnowledgeEmbeddingProvider({
            id: "fixture.embedding",
            type: "embedding",
            embed(input) {
              embeddingCalls.push(input);
              return Promise.resolve({
                embeddings: [[1, 0]],
                model: "fixture-embedding-v1",
                dimensions: 2,
              });
            },
          }),
        },
      },
      actions: {
        async searchKnowledge(input: unknown) {
          calls.push(input);
          return [{
            similarity: 0.95,
            document: {
              id: "document-a",
              namespace: NAMESPACE,
              title: "Document A",
              sourceUri: "text:document-a",
            },
            chunk: {
              id: "chunk-a",
              namespace: NAMESPACE,
              documentId: "document-a",
              chunkIndex: 0,
              content: "Durable semantic content.",
            },
          }];
        },
      },
    },
    execution: {
      id: "execution-search",
      namespace: NAMESPACE,
      threadId: "thread-a",
      participantId: "human-a",
      agentId: "support",
      toolCallId: "call-search",
      tool: { id: tool.id, key: tool.key },
      status: "running",
      content: [],
      startedAt: "2026-08-21T00:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    threadId: "thread-a",
    toolExecutionId: "execution-search",
    toolCallId: "call-search",
    agents: [],
    tools: [tool],
    collections: {},
    emitOutput: () => Promise.resolve(),
    cancelled: false,
  } as unknown as WorkflowToolExecutionContext) as Record<string, unknown>;

  assertEquals(embeddingCalls.length, 1);
  assertEquals(calls, [{
    embedding: [1, 0],
    scope: { threadId: "thread-a", agentId: "support" },
    limit: 5,
    threshold: 0.5,
  }]);
  assertEquals(output.totalResults, 1);
  assertEquals(
    (output.results as Array<Record<string, unknown>>)[0].documentId,
    "document-a",
  );
});

Deno.test("knowledge modules remain factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "collections.ts",
      "actions.ts",
      "index.ts",
      "plugin.ts",
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
