import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { ChatContext, Event, MessagePayload } from "@/types/index.ts";
import { createMemoryAssetStore } from "@/runtime/storage/assets.ts";

import { processAssetsForNewMessage } from "./asset-generator.ts";

function createTestEvent(): Event {
  return {
    id: "event-1",
    type: "NEW_MESSAGE",
    payload: {},
    parentEventId: null,
    threadId: "thread-1",
    traceId: "trace-1",
    priority: null,
    metadata: null,
    ttlMs: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    status: "pending",
  } as unknown as Event;
}

function createTestContext(options?: {
  persistGeneratedAssets?: boolean;
}): ChatContext {
  return {
    agents: [
      {
        id: "artist",
        name: "Artist",
        role: "assistant",
        llmOptions: { provider: "openai", model: "gpt-4o-mini" },
        assetOptions: options?.persistGeneratedAssets === false
          ? { produce: { persistGeneratedAssets: false } }
          : undefined,
      },
    ],
    assetStore: createMemoryAssetStore(),
  } as unknown as ChatContext;
}

Deno.test("processAssetsForNewMessage persists generated agent attachments by default", async () => {
  const emittedEvents: Event[] = [];
  const result = await processAssetsForNewMessage({
    payload: {
      sender: { type: "agent", id: "artist", name: "Artist" },
      content: [
        {
          type: "image",
          dataBase64: "AQID",
          mimeType: "image/png",
        },
      ],
    } as MessagePayload,
    baseMetadata: {},
    senderId: "artist",
    senderType: "agent",
    context: createTestContext(),
    event: createTestEvent(),
    threadId: "thread-1",
    emitToStream: (event) => {
      emittedEvents.push(event);
    },
  });

  const attachments = (result.messageMetadata?.attachments ?? []) as Array<
    Record<string, unknown>
  >;
  assertEquals(attachments.length, 1);
  assertExists(attachments[0]?.assetRef);
  assert(typeof attachments[0]?.assetRef === "string");
  assertStringIncludes(String(attachments[0]?.assetRef), "asset://");
  assertEquals(emittedEvents.length, 1);
  assertEquals(emittedEvents[0]?.type, "ASSET_CREATED");
});

Deno.test("processAssetsForNewMessage creates asset graph records without a stream", async () => {
  const createdNodes: Array<Record<string, unknown>> = [];
  const createdEdges: Array<Record<string, unknown>> = [];
  const context = {
    ...createTestContext(),
    namespace: "tenant-1",
  } as ChatContext;

  const result = await processAssetsForNewMessage({
    payload: {
      sender: { type: "agent", id: "artist", name: "Artist" },
      content: [
        {
          type: "image",
          dataBase64: "AQID",
          mimeType: "image/png",
        },
      ],
    } as MessagePayload,
    baseMetadata: {},
    senderId: "artist",
    senderType: "agent",
    context,
    ops: {
      getNodeById: async () => undefined,
      createNode: async (node: Record<string, unknown>) => {
        createdNodes.push(node);
        return node;
      },
      createEdge: async (edge: Record<string, unknown>) => {
        createdEdges.push(edge);
        return edge;
      },
    } as never,
    event: createTestEvent(),
    threadId: "thread-1",
  });

  const attachments = (result.messageMetadata?.attachments ?? []) as Array<
    Record<string, unknown>
  >;
  assertEquals(attachments.length, 1);
  assertExists(attachments[0]?.assetRef);
  assertEquals(createdNodes.length, 1);
  assertEquals(createdNodes[0]?.namespace, "tenant-1");
  assertEquals(createdNodes[0]?.type, "asset");
  assertEquals(createdEdges.length, 1);
  assertEquals(createdEdges[0]?.sourceNodeId, "thread-1");
  assertEquals(createdEdges[0]?.type, "has_asset");
});

Deno.test("processAssetsForNewMessage skips persisting direct agent attachments when disabled", async () => {
  const emittedEvents: Event[] = [];
  const result = await processAssetsForNewMessage({
    payload: {
      sender: { type: "agent", id: "artist", name: "Artist" },
      content: [
        {
          type: "image",
          dataBase64: "AQID",
          mimeType: "image/png",
        },
      ],
    } as MessagePayload,
    baseMetadata: {},
    senderId: "artist",
    senderType: "agent",
    context: createTestContext({ persistGeneratedAssets: false }),
    event: createTestEvent(),
    threadId: "thread-1",
    emitToStream: (event) => {
      emittedEvents.push(event);
    },
  });

  const attachments = (result.messageMetadata?.attachments ?? []) as Array<
    Record<string, unknown>
  >;
  assertEquals(attachments.length, 1);
  assertEquals(attachments[0]?.mimeType, "image/png");
  assertEquals(attachments[0]?.assetRef, undefined);
  assertEquals(emittedEvents.length, 0);
});

Deno.test("processAssetsForNewMessage sanitizes tool-generated assets when producer persistence is disabled", async () => {
  const emittedEvents: Event[] = [];
  const result = await processAssetsForNewMessage({
    payload: {
      sender: { type: "tool", id: "artist", name: "Artist" },
      content: "",
    } as MessagePayload,
    baseMetadata: {
      toolCalls: [
        {
          id: "tool-1",
          name: "generateImage",
          output: {
            preview: {
              mimeType: "image/png",
              dataBase64: "AQID",
            },
            note: "ready",
          },
        },
      ],
    },
    senderId: "artist",
    senderType: "tool",
    context: createTestContext({ persistGeneratedAssets: false }),
    event: createTestEvent(),
    threadId: "thread-1",
    emitToStream: (event) => {
      emittedEvents.push(event);
    },
  });

  const toolCalls = (result.messageMetadata?.toolCalls ?? []) as Array<
    Record<string, unknown>
  >;
  assertEquals(toolCalls.length, 1);

  const output = toolCalls[0]?.output as Record<string, unknown>;
  const preview = output?.preview as Record<string, unknown>;
  assertEquals(preview?.mimeType, "image/png");
  assertEquals(preview?.kind, "image");
  assertEquals(preview?.dataBase64, undefined);
  assertEquals(output?.note, "ready");
  assertEquals(result.messageMetadata?.attachments, undefined);
  assertEquals(emittedEvents.length, 0);
  assertExists(result.contentOverride);
  assertStringIncludes(String(result.contentOverride), '"kind":"image"');
  assert(!String(result.contentOverride).includes("dataBase64"));
});

Deno.test("processAssetsForNewMessage preserves exported artifact metadata on attachments", async () => {
  const result = await processAssetsForNewMessage({
    payload: {
      sender: { type: "tool", id: "artist", name: "Artist" },
      content: "",
    } as MessagePayload,
    baseMetadata: {
      toolCalls: [
        {
          id: "tool-1",
          name: "sandbox_session",
          output: {
            results: [
              {
                ok: true,
                action: "artifact",
                op: "export",
                artifact: {
                  path: "src/main.ts",
                  name: "main.ts",
                  size: 18,
                  mimeType: "text/typescript",
                  dataBase64: btoa("console.log('hi');"),
                },
              },
            ],
          },
        },
      ],
    },
    senderId: "artist",
    senderType: "tool",
    context: createTestContext(),
    event: createTestEvent(),
    threadId: "thread-1",
  });

  const attachments = (result.messageMetadata?.attachments ?? []) as Array<
    Record<string, unknown>
  >;
  assertEquals(attachments.length, 1);
  assertEquals(attachments[0]?.mimeType, "text/typescript");
  assertEquals(attachments[0]?.kind, "file");
  assertEquals(attachments[0]?.fileName, "main.ts");
  assertEquals(attachments[0]?.size, 18);
  assertExists(attachments[0]?.assetRef);

  const toolCalls = (result.messageMetadata?.toolCalls ?? []) as Array<
    Record<string, unknown>
  >;
  const output = toolCalls[0]?.output as Record<string, unknown>;
  const results = output.results as Array<Record<string, unknown>>;
  const artifact = results[0]?.artifact as Record<string, unknown>;
  assertEquals(artifact?.dataBase64, undefined);
  assertEquals(artifact?.path, "src/main.ts");
  assertEquals(artifact?.name, "main.ts");
  assertEquals(artifact?.size, 18);
  assertEquals(artifact?.fileName, "main.ts");
  assertExists(artifact?.assetRef);
});
