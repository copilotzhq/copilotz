import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "../index.ts";

Deno.test({
  name:
    "human input supersedes older pending LLM and tool continuations without dropping completed results",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const thread = await db.ops.findOrCreateThread(undefined, {
      name: "Event Supersession Test",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const threadId = thread.id as string;

    const llmCall = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { agent: { name: "East" } },
      status: "pending",
    });
    const toolCall = await db.ops.addToQueue(threadId, {
      eventType: "TOOL_CALL",
      payload: { tool: { name: "search" } },
      status: "pending",
    });
    const toolResult = await db.ops.addToQueue(threadId, {
      eventType: "TOOL_RESULT",
      payload: { content: "done" },
      status: "pending",
    });
    const humanMessage = await db.ops.addToQueue(threadId, {
      eventType: "NEW_MESSAGE",
      payload: {
        content: "stop and do this instead",
        sender: { type: "user", id: "user-1" },
      },
      status: "pending",
    });
    const llmCallId = llmCall.id as string;
    const toolCallId = toolCall.id as string;
    const toolResultId = toolResult.id as string;
    const humanMessageId = humanMessage.id as string;

    await db.query(
      `UPDATE "events"
       SET "createdAt" = CASE
         WHEN "id" IN ($1, $2, $3) THEN TIMESTAMPTZ '2026-06-10T16:00:00Z'
         WHEN "id" = $4 THEN TIMESTAMPTZ '2026-06-10T16:05:00Z'
         ELSE "createdAt"
       END`,
      [llmCallId, toolCallId, toolResultId, humanMessageId],
    );

    assertEquals(
      await db.ops.hasNewerHumanInput(
        threadId,
        "2026-06-10T16:00:00Z",
      ),
      true,
    );
    assertEquals(
      await db.ops.hasNewerHumanInput(
        threadId,
        "2026-06-10T16:06:00Z",
      ),
      false,
    );

    const overwritten = await db.ops.overwritePendingAgentContinuations(
      threadId,
      "2026-06-10T16:05:00Z",
    );

    assertEquals(overwritten, 2);
    assertEquals(
      (await db.ops.getQueueItemById(llmCallId))?.status,
      "overwritten",
    );
    assertEquals(
      (await db.ops.getQueueItemById(toolCallId))?.status,
      "overwritten",
    );
    assertEquals(
      (await db.ops.getQueueItemById(toolResultId))?.status,
      "pending",
    );
  },
});
