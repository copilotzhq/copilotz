import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import {
  applyContinuityPatch,
  buildContinuityRetrievalTexts,
  createEmptyContinuity,
  extractVisibleBrainNodeIds,
  parseMemoryConsolidationProposal,
  renderLongTermMemory,
  selectLongTermMemoryRange,
  stableMemoryNodeId,
} from "./consolidation.ts";

Deno.test("continuity patches preserve omitted fields and expose stable refs", () => {
  const initial = applyContinuityPatch(createEmptyContinuity(), {
    intent: {
      challenge: {
        value: "Preserve the user's goal across rollovers.",
        sourceMessageIds: ["message-1"],
      },
    },
    state: {
      openQuestions: {
        value: ["How should retrieval support continuity?"],
        sourceMessageIds: ["message-1"],
      },
    },
  });
  const updated = applyContinuityPatch(initial, {
    state: {
      openQuestions: { value: [], sourceMessageIds: ["message-2"] },
    },
  });
  assertEquals(updated.intent.challenge, initial.intent.challenge);
  assertEquals(updated.state.openQuestions, {
    value: [],
    sourceMessageIds: ["message-2"],
  });
  const rendered = renderLongTermMemory({
    proposal: { continuityPatch: {}, nodes: [], relations: [] },
    continuity: updated,
    newBrainNodes: new Map(),
    olderBrainNodes: [],
    olderRelations: [],
    maxContentEstimatedTokens: 2_000,
  });
  assertStringIncludes(
    rendered,
    "[continuity:intent.challenge] Challenge: Preserve the user's goal across rollovers.",
  );
  assertEquals(buildContinuityRetrievalTexts(updated), [
    "challenge: Preserve the user's goal across rollovers.",
  ]);
});

Deno.test("proposal validation constrains provenance, spaces, and older nodes", () => {
  const parsed = parseMemoryConsolidationProposal(
    JSON.stringify({
      continuityPatch: {
        state: {
          currentState: {
            value: "The migration is underway.",
            sourceMessageIds: ["message-1", "foreign-message"],
          },
        },
      },
      nodes: [{
        localId: "decision-1",
        kind: "decision",
        name: "Use events",
        content: "The architecture uses durable semantic events.",
        confidence: 2,
        sourceMessageIds: ["message-1", "foreign-message"],
        memorySpaceId: "read-only-space",
        supersedesNodeId: "older-1",
      }],
      relations: [{
        source: "decision-1",
        type: "supersedes",
        target: "older-1",
      }],
    }),
    new Set(["message-1"]),
    new Set(["older-1"]),
    {
      writableMemorySpaceIds: new Set(["write-space"]),
      defaultWriteMemorySpaceId: "write-space",
    },
  );
  assertEquals(parsed.nodes[0], {
    localId: "decision-1",
    kind: "decision",
    name: "Use events",
    content: "The architecture uses durable semantic events.",
    sourceMessageIds: ["message-1"],
    memorySpaceId: "write-space",
    confidence: 1,
    supersedesNodeId: "older-1",
  });
  assertEquals(parsed.relations, [{
    source: "decision-1",
    type: "supersedes",
    target: "older-1",
  }]);
});

Deno.test("proposal continuity requires current-range provenance", () => {
  assertThrows(
    () =>
      parseMemoryConsolidationProposal(
        JSON.stringify({
          continuityPatch: {
            state: {
              currentState: {
                value: "Unsupported",
                sourceMessageIds: ["older-message"],
              },
            },
          },
          nodes: [],
          relations: [],
        }),
        new Set(["message-1"]),
        new Set(),
        {
          writableMemorySpaceIds: new Set(["space"]),
          defaultWriteMemorySpaceId: "space",
        },
      ),
    Error,
    "Invalid long-term-memory continuity field",
  );
});

Deno.test("range selection preserves tool-result units and advances boundaries", () => {
  const messages = [
    { id: "boundary", senderType: "agent", senderId: "a", text: "old" },
    { id: "user", senderType: "human", senderId: "u", text: "A".repeat(40) },
    { id: "agent", senderType: "agent", senderId: "a", text: "B".repeat(40) },
    { id: "tool", senderType: "tool", senderId: "t", text: "C".repeat(40) },
  ];
  const selected = selectLongTermMemoryRange({
    messages,
    triggerMessageId: "tool",
    previousBoundaryMessageId: "boundary",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.messages.map((message) => message.id), ["user"]);
  assertEquals(selected?.retainedMessageCount, 2);
  assertEquals(selected?.sourceStartMessageId, "user");
  assertEquals(selected?.sourceEndMessageId, "user");
});

Deno.test("rendering keeps blocks whole and stable IDs are replay-safe", () => {
  const oversized = "OVERSIZED_MEMORY_BLOCK_".repeat(20);
  const continuity = applyContinuityPatch(createEmptyContinuity(), {
    state: {
      currentState: {
        value: oversized,
        sourceMessageIds: ["message-1"],
      },
    },
  });
  const rendered = renderLongTermMemory({
    proposal: { continuityPatch: {}, nodes: [], relations: [] },
    continuity,
    newBrainNodes: new Map(),
    olderBrainNodes: [],
    olderRelations: [],
    maxContentEstimatedTokens: 30,
  });
  assertEquals(rendered.includes("OVERSIZED_MEMORY_BLOCK_"), false);
  assertEquals(
    stableMemoryNodeId("checkpoint-1", "decision one"),
    "checkpoint-1:brain:decision%20one",
  );
});

Deno.test("visible node IDs are extracted without duplicates", () => {
  assertEquals(
    extractVisibleBrainNodeIds([
      "- [id:brain-1] [fact] One",
      "- [id:brain-2] [fact] Two",
      "- [id:brain-1] [fact] One again",
    ].join("\n")),
    ["brain-1", "brain-2"],
  );
});
