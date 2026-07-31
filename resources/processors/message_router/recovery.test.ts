import { assertEquals } from "@std/assert";

import { createDatabase } from "@/database/index.ts";
import type { ChatMessage } from "@/runtime/llm/types.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { messageProcessor } from "./message.created.ts";

Deno.test("internal recovery cue follows the normal router into one continuation attempt", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = `recovery-router-${crypto.randomUUID()}`;
  const thread = await db.ops.findOrCreateThread("thread-recovery", {
    namespace,
    name: "Recovery router",
    participants: ["user-1", "assistant"],
    status: "active",
    mode: "immediate",
  });
  const recovery = {
    chainId: "chain-1",
    count: 1,
    reason: "timeout",
    joinSeparator: " ",
    providerIndex: 0,
  };

  try {
    await db.ops.mutate.messages.create({
      id: "recovery-fragment",
      threadId: String(thread.id),
      senderId: "assistant",
      senderType: "agent",
      content: "Partial answer",
      metadata: {
        skipRouting: true,
        recovery: { ...recovery, kind: "fragment", sequence: 1 },
      },
    }, namespace);
    const cue = await db.ops.mutate.messages.create({
      id: "recovery-cue",
      threadId: String(thread.id),
      senderId: "copilotz-recovery",
      senderType: "job",
      content: "<recovery_cue>Continue.</recovery_cue>",
      metadata: {
        visibility: "internal",
        recovery: { ...recovery, kind: "cue", sequence: 2 },
      },
    }, namespace);

    const result = await messageProcessor.process({
      id: "evt-recovery-cue",
      threadId: String(thread.id),
      subjectType: "message",
      subjectId: cue.id,
      type: "message.created",
      payload: {
        content: cue.content,
        sender: {
          id: "copilotz-recovery",
          type: "job",
          name: "Copilotz Recovery",
        },
        metadata: cue.metadata,
      },
      metadata: {
        targetId: "assistant",
        sourceMessageSenderId: "copilotz-recovery",
        sourceMessageSenderType: "job",
      },
    } as unknown as Event, {
      db,
      thread,
      context: {
        namespace,
        agents: [{
          id: "assistant",
          name: "Assistant",
          role: "assistant",
          instructions: "Continue the answer.",
          llmOptions: { provider: "openai", model: "gpt-5.6" },
        }],
      },
      emitToStream: () => {},
    } as unknown as ProcessorDeps);

    assertEquals(result?.producedEvents, []);
    const attempts = await db.ops.unsafeGraph.getNodesByNamespace(
      namespace,
      "llm_attempt",
    );
    assertEquals(attempts.length, 1);
    const messages = (attempts[0].data as Record<string, unknown>)
      .messages as ChatMessage[];
    const fragmentIndex = messages.findIndex((message) =>
      String(message.content).includes("Partial answer")
    );
    const cueIndex = messages.findIndex((message) =>
      String(message.content).includes("<recovery_cue>")
    );
    assertEquals(fragmentIndex >= 0, true);
    assertEquals(cueIndex > fragmentIndex, true);
    assertEquals(messages[cueIndex].role, "user");
    assertEquals(
      String(messages[cueIndex].content).includes("<message_timestamp>"),
      false,
    );
  } finally {
    await db.close();
  }
});
