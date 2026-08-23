import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { projectMessages } from "../../runtime/testing/projections.ts";

import { createCopilotz } from "@copilotz/copilotz/application";
import type { ActionCallOptions } from "@copilotz/copilotz/actions";
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
import type { ToolResource } from "@copilotz/copilotz/tools";
import {
  createKnowledgePlugin,
  defineKnowledgeEmbeddingProvider,
} from "./index.ts";
import {
  deleteKnowledgeDocumentAction,
  type KnowledgeActionCallers,
  type KnowledgeActionContext,
} from "./actions.ts";
import type { KnowledgeChunk, KnowledgeDocument } from "./types.ts";

const NAMESPACE = "tenant-knowledge";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type KnowledgeToolActionCallers = Readonly<{
  ingest_document(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  search_knowledge(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  delete_document(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
}>;

type KnowledgeToolProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{ actions: KnowledgeToolActionCallers }>;

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
    "ingest_document",
    "search_knowledge",
    "delete_document",
  ]);
  assertEquals(
    Object.values(plugin.actions).map((action) => action.id),
    [
      "copilotz.knowledge.indexDocument",
      "copilotz.knowledge.ingestDocument",
      "copilotz.knowledge.searchDocuments",
      "copilotz.knowledge.deleteDocument",
    ],
  );
  assertEquals(Object.keys(plugin.processors), ["indexKnowledgeDocument"]);
  assertEquals(Object.keys(plugin.resources.tools), [
    "ingest_document",
    "search_knowledge",
    "delete_document",
  ]);
  for (const [alias, resource] of Object.entries(plugin.resources.tools)) {
    assertEquals(resource.action, alias);
    assertEquals(plugin.actions[alias]?.inputSchema, resource.inputSchema);
  }
  assertEquals("features" in plugin, false);
});

Deno.test("knowledge configured Tool aliases populate both plugin maps", () => {
  const plugin = createKnowledgePlugin({
    embedding: { provider: "fixture.embedding" },
    tools: {
      ingestId: "add_source",
      searchId: "find_source",
      deleteId: "remove_source",
    },
  });
  assertEquals(Object.keys(plugin.actions), [
    "indexKnowledgeDocument",
    "add_source",
    "find_source",
    "remove_source",
  ]);
  assertEquals(Object.keys(plugin.resources.tools), [
    "add_source",
    "find_source",
    "remove_source",
  ]);
  for (const [alias, resource] of Object.entries(plugin.resources.tools)) {
    assertEquals(resource.action, alias);
    assertExists(plugin.actions[alias]);
  }
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
      (await knowledge.actions.search_knowledge({
        query: "durable semantics",
        scope: { threadId: "thread-a" },
        threshold: 0.5,
      })).results.map((result) => result.documentId),
      ["document-a"],
    );
    assertEquals(
      (await knowledge.actions.search_knowledge({
        query: "durable semantics",
        scope: { threadId: "another-thread" },
      })).results,
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
      calls.some((call) => call.idempotencyKey.includes("knowledge-embed")),
    );
    assert(
      calls.some((call) => call.idempotencyKey.includes("knowledge-query")),
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

    const deleted = await knowledge.actions.delete_document({
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

Deno.test("knowledge Tool Actions execute through durable callers", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const outputs = new Map<string, unknown>();
  const driver = defineProcessor<KnowledgeToolProcessorContext>({
    id: "fixture.knowledge-tools",
    on: [{ eventType: "fixture.knowledge_tool.requested" }],
    async handle(event, processor) {
      if (!event.durable || !event.threadId) return;
      const payload = event.payload as {
        toolId: string;
        arguments: Record<string, unknown>;
      };
      const resource = processor.resources.tools?.[payload.toolId] as
        | ToolResource
        | undefined;
      if (!resource || resource.action !== payload.toolId) {
        throw new Error(`Unknown tool '${payload.toolId}'.`);
      }
      const options: ActionCallOptions = {
        operationKey: `${processor.operationKey}:${payload.toolId}`,
        metadata: {
          threadId: event.threadId,
          agentId: "support",
          initiatorParticipantId: "agent-a",
        },
        signal: processor.signal,
      };
      const output = resource.action === "ingest_document"
        ? await processor.actions.ingest_document(payload.arguments, options)
        : resource.action === "search_knowledge"
        ? await processor.actions.search_knowledge(payload.arguments, options)
        : resource.action === "delete_document"
        ? await processor.actions.delete_document(payload.arguments, options)
        : (() => {
          throw new Error(`Unknown tool '${payload.toolId}'.`);
        })();
      outputs.set(event.id, output);
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
      metadata: {
        threadId: "forged-thread",
        agentId: "forged-agent",
        initiatorParticipantId: "forged-participant",
        scope: {
          threadId: "forged-thread",
          agentId: "forged-agent",
          initiatorParticipantId: "forged-participant",
        },
      },
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
    const document = await knowledge.documents.get({ id: documentId }) as
      | KnowledgeDocument
      | null;
    assertExists(document);
    assertEquals(document.threadId, "thread-a");
    assertEquals(document.requestedByParticipantId, "agent-a");
    assertEquals(record(document.metadata).threadId, "thread-a");
    assertEquals(record(document.metadata).agentId, "support");
    assertEquals(
      record(record(document.metadata).scope).initiatorParticipantId,
      "agent-a",
    );
    const search = await invoke("search_knowledge", {
      query: "How is worker state stored?",
      threshold: 0.5,
      scope: { threadId: "forged-thread", agentId: "forged-agent" },
    });
    const results = search.results as Array<Record<string, unknown>>;
    assertEquals(results.length, 1);
    assertEquals(results[0].documentId, documentId);
    assertStringIncludes(String(results[0].content), "Workers keep");
    const crossThreadDeletion = await knowledge.actions.delete_document({
      documentId,
    }, {
      operationKey: "portable-workers:delete:cross-thread",
      metadata: {
        threadId: "thread-b",
        agentId: "support",
        initiatorParticipantId: "agent-b",
      },
    });
    assertEquals(crossThreadDeletion.success, false);
    assertExists(await knowledge.documents.get({ id: documentId }));
    const crossAgentDeletion = await knowledge.actions.delete_document({
      documentId,
    }, {
      operationKey: "portable-workers:delete:cross-agent",
      metadata: {
        threadId: "thread-a",
        agentId: "other-agent",
        initiatorParticipantId: "agent-a",
      },
    });
    assertEquals(crossAgentDeletion.success, false);
    assertExists(await knowledge.documents.get({ id: documentId }));
    const deletion = await invoke("delete_document", { documentId });
    assertEquals(deletion.success, true);
    assertEquals(deletion.documentId, documentId);
    assertEquals(await knowledge.documents.get({ id: documentId }), null);

    const repeatedSourceUri = "https://example.test/shared-source";
    for (
      const [id, agentId] of [
        ["document-shared-agent-a", "agent-a"],
        ["document-shared-agent-b", "agent-b"],
      ] as const
    ) {
      await knowledge.documents.create({
        id,
        title: `Shared source for ${agentId}`,
        source: [],
        sourceType: "url",
        sourceUri: repeatedSourceUri,
        mediaType: null,
        contentHash: null,
        status: "indexed",
        chunkCount: 0,
        duplicateOfDocumentId: null,
        threadId: null,
        requestedByParticipantId: null,
        forceReindex: false,
        error: null,
        externalId: null,
        metadata: { scope: { agentId } },
      }, { operationKey: `${id}:create` });
    }
    const scopedSourceDeletion = await knowledge.actions.delete_document({
      sourceUri: repeatedSourceUri,
    }, {
      operationKey: "shared-source:delete:agent-a",
      metadata: { agentId: "agent-a" },
    });
    assertEquals(scopedSourceDeletion.success, true);
    if (!scopedSourceDeletion.success) {
      throw new Error(scopedSourceDeletion.message);
    }
    assertEquals(scopedSourceDeletion.documentId, "document-shared-agent-a");
    assertEquals(
      await knowledge.documents.get({ id: "document-shared-agent-a" }),
      null,
    );
    assertExists(
      await knowledge.documents.get({ id: "document-shared-agent-b" }),
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("knowledge source deletion searches every page without crossing scope", async () => {
  const sourceUri = "https://example.test/paginated-source";
  const document = (
    id: string,
    threadId: string,
    agentId: string,
  ): KnowledgeDocument =>
    Object.freeze({
      id,
      namespace: NAMESPACE,
      sourceType: "url",
      sourceUri,
      title: id,
      mediaType: null,
      contentHash: null,
      source: Object.freeze([]),
      status: "indexed",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId,
      requestedByParticipantId: null,
      forceReindex: false,
      error: null,
      externalId: null,
      metadata: Object.freeze({ scope: { agentId } }),
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
  const documents = Object.freeze([
    ...Array.from(
      { length: 1_000 },
      (_, index) =>
        document(
          `document:${String(index).padStart(4, "0")}`,
          "thread-b",
          "agent-b",
        ),
    ),
    document("document:z-authorized", "thread-a", "agent-a"),
  ]);
  const cursors: Array<string | undefined> = [];
  const limits: number[] = [];
  const deleted: string[] = [];
  const context = {
    namespace: NAMESPACE,
    operationKey: "paginated-delete",
    action: {
      id: deleteKnowledgeDocumentAction.id,
      runId: "paginated-delete-run",
      metadata: { threadId: "thread-a", agentId: "agent-a" },
    },
    collections: {
      document: {
        get: () => Promise.resolve(null),
        list(query: Readonly<{ after?: string; limit?: number }>) {
          cursors.push(query.after);
          limits.push(query.limit ?? 0);
          const after = query.after ?? "";
          return Promise.resolve(
            documents.filter((candidate) => candidate.id > after).slice(
              0,
              query.limit,
            ),
          );
        },
      },
      chunk: { list: () => Promise.resolve([]) },
    },
    async transaction(
      execute: (
        transaction: Readonly<{
          collections: Readonly<{
            chunk: Readonly<{
              delete(input: Readonly<{ id: string }>): Promise<unknown>;
            }>;
            document: Readonly<{
              delete(input: Readonly<{ id: string }>): Promise<unknown>;
            }>;
          }>;
          relations: Readonly<Record<string, never>>;
        }>,
      ) => unknown,
    ) {
      return await execute({
        collections: {
          chunk: { delete: () => Promise.resolve({ deleted: true }) },
          document: {
            delete(input) {
              deleted.push(input.id);
              return Promise.resolve({ deleted: true });
            },
          },
        },
        relations: {},
      });
    },
  } as unknown as KnowledgeActionContext;

  const result = await deleteKnowledgeDocumentAction.execute(
    { sourceUri },
    context,
  );

  assertEquals(result.success, true);
  if (!result.success) throw new Error(result.message);
  assertEquals(result.documentId, "document:z-authorized");
  assertEquals(deleted, ["document:z-authorized"]);
  assertEquals(cursors, [undefined, "document:0999"]);
  assertEquals(limits, [1_000, 1_000]);
});

Deno.test("knowledge can disable every model-facing Action and Tool Resource", () => {
  const plugin = createKnowledgePlugin({
    embedding: { provider: "fixture.embedding" },
    tools: false,
  });
  assertEquals(Object.keys(plugin.actions), ["indexKnowledgeDocument"]);
  assertEquals(plugin.resources.tools, {});
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
