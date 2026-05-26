import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { createMemoryAssetStore } from "@/runtime/storage/assets.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { messageProcessor } from "./index.ts";

Deno.test("message coalescing normalizes absorbed data URL attachments before persistence", async () => {
  const tempDir = await Deno.makeTempDir();
  const db = await createDatabase({ url: `file://${tempDir}/coalescing.db` });
  const namespace = "tenant-a";
  try {
    const thread = await db.ops.findOrCreateThread("thread-1", {
      name: "Main Thread",
      namespace,
      participants: ["user-1", "assistant"],
      status: "active",
      mode: "immediate",
    });
    const assetStore = createMemoryAssetStore();
    const audioDataUrl = "data:audio/webm;codecs=opus;base64,AQIDBA==";
    const emittedEvents: Event[] = [];

    await db.ops.addToQueue("thread-1", {
      eventType: "NEW_MESSAGE",
      namespace,
      traceId: "trace-1",
      metadata: { targetId: "assistant" },
      payload: {
        content: "voice note",
        sender: { type: "user", id: "user-1", name: "User One" },
        metadata: {
          attachments: [{
            kind: "audio",
            size: 4,
            dataUrl: audioDataUrl,
            fileName: "voice.webm",
            mimeType: "audio/webm;codecs=opus",
            durationMs: 60_005,
          }],
        },
      },
    });

    const event = {
      id: "event-current",
      threadId: "thread-1",
      type: "NEW_MESSAGE",
      payload: {
        content: "hello",
        sender: { type: "user", id: "user-1", name: "User One" },
      },
      metadata: { targetId: "assistant" },
      traceId: "trace-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "pending",
    } as unknown as Event;

    await messageProcessor.process(event, {
      db,
      thread,
      context: {
        namespace,
        agents: [{
          id: "assistant",
          name: "assistant",
          role: "assistant",
          instructions: "Help the user.",
          llmOptions: { provider: "openai", model: "gpt-4o-mini" },
        }],
        assetStore,
      },
      emitToStream: (streamEvent: Event) => emittedEvents.push(streamEvent),
    } as unknown as ProcessorDeps);

    const messages = await db.ops.getMessageHistoryFromGraph("thread-1", 10);
    const absorbed = messages.find((message) =>
      message.content === "voice note"
    );
    assertExists(absorbed);

    const attachments = (absorbed.metadata?.attachments ?? []) as Array<
      Record<string, unknown>
    >;
    assertEquals(attachments.length, 1);
    assertEquals(attachments[0]?.kind, "audio");
    assertEquals(attachments[0]?.dataUrl, undefined);
    assertEquals(attachments[0]?.mimeType, "audio/webm");
    assert(typeof attachments[0]?.assetRef === "string");
    assertStringIncludes(String(attachments[0]?.assetRef), "asset://");
    assertEquals(
      emittedEvents.some((streamEvent) =>
        (streamEvent.type as string) === "ASSET_CREATED"
      ),
      true,
    );
  } finally {
    await (db as { close?: () => Promise<void> | void }).close?.();
    await Deno.remove(tempDir, { recursive: true });
  }
});
