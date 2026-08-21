import { assertEquals, assertExists } from "@std/assert";
import { join, toFileUrl } from "../../../dependencies/std-path.ts";

import {
  closePhase0ConversationFixture,
  createPhase0ConversationFixture,
  PHASE_0_NAMESPACE,
  seedPhase0Conversation,
  snapshotPhase0Conversation,
} from "./conversation-fixture.ts";

/**
 * Locked 0.60.18 conversation shape. Phase 3+ must keep these facts readable
 * after native repositories are replaced. Event names may change only through
 * an explicit migration recorded in the handoff.
 */
const EXPECTED_EVENT_TYPES = Object.freeze([
  "participant.created",
  "participant.created",
  "participant.created",
  "thread.created",
  "message.created",
  "llm_attempt.created",
  "llm_attempt.completed",
  "message.created",
  "tool_execution.created",
  "tool_execution.completed",
  "message.created",
  "message.revised",
]);

Deno.test("phase-0 conversation fixture captures native graph, events, branch, and external ids", async () => {
  const fixture = await createPhase0ConversationFixture();
  try {
    await seedPhase0Conversation(fixture);
    const snapshot = await snapshotPhase0Conversation(fixture);
    assertEquals(snapshot.eventTypes, EXPECTED_EVENT_TYPES);
    assertEquals(snapshot.participantExternalIds, [
      "alice",
      "research",
      "support",
    ]);
    assertEquals(snapshot.threadExternalId, "customer-thread-42");
    assertEquals(snapshot.activeMessageIds.includes("message-user"), false);
    assertEquals(snapshot.activeMessageIds[0], "message-user-revised");
    assertEquals(snapshot.allMessageIds.includes("message-user"), true);
    assertEquals(snapshot.revisionIds, [
      "message-user",
      "message-user-revised",
    ]);
    assertEquals(snapshot.lastEventType, "message.revised");
    assertExists(snapshot.lastEventId);
    assertEquals(snapshot.nodeCounts.participant, 3);
    assertEquals(snapshot.nodeCounts.thread, 1);
    assertEquals(snapshot.nodeCounts.message, 4);
    assertEquals(snapshot.nodeCounts.llm_attempt, 1);
    assertEquals(snapshot.nodeCounts.tool_execution, 1);
    assertEquals((snapshot.nodeCounts.asset ?? 0) > 0, true);
    const byExternal = await fixture.conversation.getParticipantByExternalId(
      PHASE_0_NAMESPACE,
      "alice",
    );
    assertEquals(byExternal?.id, "human-alice");
  } finally {
    await closePhase0ConversationFixture(fixture);
  }
});

Deno.test("phase-0 conversation fixture survives persistent PGlite close and reopen", async () => {
  const directory = await Deno.makeTempDir({ prefix: "copilotz-phase0-" });
  const url = toFileUrl(join(directory, "conversation.db")).href;
  try {
    const written = await createPhase0ConversationFixture({ url });
    try {
      await seedPhase0Conversation(written);
      const before = await snapshotPhase0Conversation(written);
      assertEquals(before.eventTypes, EXPECTED_EVENT_TYPES);
    } finally {
      await closePhase0ConversationFixture(written);
    }

    const reopened = await createPhase0ConversationFixture({ url });
    try {
      const after = await snapshotPhase0Conversation(reopened);
      assertEquals(after.eventTypes, EXPECTED_EVENT_TYPES);
      assertEquals(after.participantExternalIds, [
        "alice",
        "research",
        "support",
      ]);
      assertEquals(after.threadExternalId, "customer-thread-42");
      assertEquals(after.activeMessageIds[0], "message-user-revised");
      assertEquals(after.allMessageIds.includes("message-user"), true);
      assertEquals(after.nodeCounts.llm_attempt, 1);
      assertEquals(after.nodeCounts.tool_execution, 1);
      const thread = await reopened.conversation.getThread(
        PHASE_0_NAMESPACE,
        "thread-support",
      );
      assertEquals(thread?.participants.length, 3);
    } finally {
      await closePhase0ConversationFixture(reopened);
    }
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
