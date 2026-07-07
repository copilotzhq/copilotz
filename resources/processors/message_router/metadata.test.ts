import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { messageProcessor } from "./message.created.ts";

Deno.test("new_message persists LLM result usage metadata on assistant messages", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-metadata";
  const thread = await db.ops.findOrCreateThread("thread-metadata", {
    namespace,
    name: "Metadata Thread",
    participants: ["assistant", "user-1"],
    status: "active",
    mode: "immediate",
  });

  try {
    await messageProcessor.process(
      {
        id: "evt-new-message",
        threadId: "thread-metadata",
        type: "NEW_MESSAGE",
        payload: {
          content: "Assistant answer",
          sender: { type: "agent", id: "assistant", name: "Assistant" },
          metadata: { source: "llm_result" },
        },
        parentEventId: "evt-llm-result",
        traceId: "trace-metadata",
        priority: 1000,
        metadata: {
          targetId: "user-1",
          usageNodeId: "usage-node-1",
          llmError: { reason: "rate_limit" },
        },
        ttlMs: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "processing",
      } as unknown as Event,
      {
        db,
        thread,
        context: {
          namespace,
          agents: [{
            id: "assistant",
            name: "Assistant",
            role: "assistant",
            instructions: "Help.",
            llmOptions: { provider: "openai", model: "gpt-4o-mini" },
          }],
        },
        emitToStream: () => {},
      } as unknown as ProcessorDeps,
    );

    const messages = await db.ops.getMessageHistoryFromGraph(
      "thread-metadata",
    );
    assertEquals(messages.length, 1);
    const metadata = messages[0].metadata as Record<string, unknown>;
    assertExists(metadata);
    assertEquals(metadata.source, "llm_result");
    assertEquals(metadata.usageNodeId, "usage-node-1");
    assertEquals(
      (metadata.llmError as Record<string, unknown>).reason,
      "rate_limit",
    );
  } finally {
    await (db as { close?: () => Promise<void> | void }).close?.();
  }
});
