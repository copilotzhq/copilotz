import { assertEquals, assertThrows } from "@std/assert";
import {
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  coreToolActionMetadata,
  coreToolActionOrigin,
  defineCoreToolActionMetadata,
} from "./workflow-metadata.ts";

const origin = {
  schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
  planId: "plan",
  planMessageId: "plan-message",
  planIndex: 0,
  planSize: 1,
  stageIndex: 0,
  stageCount: 1,
  toolCallId: "call",
  action: "lookup",
  threadId: "thread",
  triggerMessageId: "trigger",
  agentId: "agent",
  agentParticipantId: "agent-participant",
  initiatorParticipantId: "human",
  availableToolIds: ["lookup"],
  responseVisibility: { kind: "public" as const },
  parentLlmActionRunId: "llm-run",
} as const;

Deno.test("Core metadata extraction separates app fields but preserves strict origin schemas", () => {
  const metadata = {
    ...origin,
    appIdentity: { id: "human" },
    httpActor: { id: "human" },
  };
  assertEquals(coreToolActionMetadata(metadata), origin);
  assertEquals(coreToolActionOrigin(metadata), null);
  assertThrows(() => defineCoreToolActionMetadata(metadata), TypeError);
  for (
    const patch of [
      { threadId: "" },
      { stageIndex: 1 },
      { agentParticipantId: null },
      { responseVisibility: { kind: "public", participantIds: ["human"] } },
      { ask: { phase: "answer" } },
      { agentTurn: { threadId: "forged" } },
    ]
  ) assertEquals(coreToolActionMetadata({ ...metadata, ...patch }), null);
});

Deno.test("Tool visibility metadata preserves the initiator and rejects malformed grants", () => {
  const visibility = {
    kind: "tool" as const,
    policy: "public_status" as const,
    requesterId: "agent-participant",
    initiatorId: "human",
  };
  const metadata = defineCoreToolActionMetadata({
    ...origin,
    responseVisibility: visibility,
    outputVisibility: visibility,
  });
  assertEquals(coreToolActionOrigin(metadata)?.outputVisibility, visibility);
  for (const initiatorId of ["", null, 42]) {
    assertEquals(
      coreToolActionMetadata({
        ...origin,
        responseVisibility: { ...visibility, initiatorId },
      }),
      null,
    );
  }
});
