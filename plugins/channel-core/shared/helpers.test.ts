import { assertEquals } from "@std/assert";
import { isPublicChannelMessage } from "./helpers.ts";

const baseMessage = {
  metadata: {},
  content: [],
};

Deno.test("public channel message policy preserves public and legacy rows", () => {
  assertEquals(isPublicChannelMessage(baseMessage), true);
  assertEquals(
    isPublicChannelMessage({
      ...baseMessage,
      visibility: { kind: "public" },
      recipientIds: [],
    }),
    true,
  );
  assertEquals(
    isPublicChannelMessage({
      ...baseMessage,
      metadata: {
        llmToolCalls: [{ id: "call-a", name: "buttons" }],
      },
    }),
    true,
  );
});

Deno.test("public channel message policy rejects private or malformed rows", () => {
  const rejected = [
    { visibility: { kind: "participants", participantIds: ["human-a"] } },
    { visibility: { kind: "internal" } },
    { visibility: { kind: "tool", policy: "public", requesterId: "human-a" } },
    { visibility: {} },
    { visibility: "public" },
    { historyScopeId: "agent-turn-a" },
    { historyScopeId: 42 },
    { recipientIds: ["  "] },
    { recipientIds: "human-a" },
    { metadata: { copilotzAgentTurn: { history: "scope" } } },
    { metadata: { copilotzAgentTurn: { history: "public" } } },
    { metadata: { copilotzAsk: { mode: "private" } } },
    { metadata: { copilotzAsk: { mode: "unknown" } } },
    { metadata: { copilotzAsk: null } },
  ];
  for (const fields of rejected) {
    assertEquals(isPublicChannelMessage({ ...baseMessage, ...fields }), false);
  }
});
