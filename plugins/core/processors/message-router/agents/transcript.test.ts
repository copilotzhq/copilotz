import { assertEquals } from "@std/assert";
import type { ConversationMessage } from "../../../shared/contracts.ts";
import {
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  coreToolPlanResultMetadata,
  withAgentAskMetadata,
  withAgentAskResultMetadata,
  withCoreToolPlanMetadata,
  withCoreToolPlanResultMetadata,
} from "../../../shared/workflow-metadata.ts";
import { buildLlmTranscript } from "../../../shared/agents/transcript.ts";

const participant = (id: string, participantType: "agent" | "tool") =>
  ({
    id,
    namespace: "tenant",
    externalId: id,
    participantType,
    metadata: {},
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  }) as const;

function message(
  id: string,
  sender: ReturnType<typeof participant>,
  metadata: Readonly<Record<string, unknown>>,
): ConversationMessage {
  return {
    id,
    namespace: "tenant",
    threadId: "thread",
    sender,
    recipientIds: ["north"],
    content: [{
      assetId: `asset:${id}`,
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
    metadata,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

function result(id: string, planId: string): ConversationMessage {
  return message(
    id,
    participant("tool", "tool"),
    withCoreToolPlanResultMetadata({ requesterId: "north" }, {
      schema: "copilotz.core.tool-plan-result.v1",
      resultKind: "pipeline_failure",
      failedStageIndex: 0,
      failedAction: "lookup",
      origin: {
        schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
        planId,
        planMessageId: `message:${planId}`,
        planIndex: 0,
        stageIndex: 0,
        stageCount: 1,
        planSize: 1,
        toolCallId: "shared",
        action: "lookup",
        threadId: "thread",
        triggerMessageId: "trigger",
        agentId: "north",
        agentParticipantId: "north",
        initiatorParticipantId: "human",
        availableToolIds: ["lookup"],
        responseVisibility: { kind: "public" },
        parentLlmActionRunId: `llm:${planId}`,
      },
    }),
  );
}

Deno.test("transcript keeps overlapping plans chronological and plan-qualified", () => {
  const plan = (id: string, planId: string) =>
    message(
      id,
      participant("north", "agent"),
      withCoreToolPlanMetadata({
        llmToolCalls: [{ id: "shared", action: "lookup", input: {} }],
      }, {
        schema: CORE_TOOL_PLAN_METADATA_SCHEMA,
        planId,
        planSize: 1,
      }),
    );
  const transcript = buildLlmTranscript({
    threadId: "thread",
    participantId: "north",
    history: [
      plan("plan:a", "a"),
      plan("plan:b", "b"),
      result("result:b", "b"),
    ],
  });
  assertEquals(transcript.map((item) => item.role), [
    "assistant",
    "assistant",
    "tool",
  ]);
  assertEquals(
    transcript[0]?.role === "assistant" ? transcript[0].toolPlanId : null,
    "a",
  );
  assertEquals(
    transcript[1]?.role === "assistant" ? transcript[1].toolPlanId : null,
    "b",
  );
  assertEquals(
    transcript[2]?.role === "tool" ? transcript[2].toolPlanId : null,
    "b",
  );
});

Deno.test("consolidation may split an Ask answer from its receipt without losing or repeating content", () => {
  const rawReceipt = result("receipt", "plan");
  const receipt = {
    ...rawReceipt,
    metadata: withAgentAskResultMetadata(rawReceipt.metadata, {
      schema: "copilotz.ask-result.v1",
      askId: "ask",
      status: "completed",
      askedParticipantId: "south",
      askedAgentId: "south",
      answerMessageId: "answer",
    }),
  };
  const answer = message(
    "answer",
    participant("south", "agent"),
    withAgentAskMetadata({}, {
      schema: "copilotz.ask.v1",
      askId: "ask",
      phase: "answer",
      mode: "private",
      toolActionRunId: "action",
      questionMessageId: "question",
      askingParticipantId: "north",
      askingAgentId: "north",
      askedParticipantId: "south",
      askedAgentId: "south",
      origin: coreToolPlanResultMetadata(receipt.metadata)!.origin,
      depth: 1,
    }),
  );
  const input = {
    threadId: "thread",
    participantId: "north",
    history: [answer, receipt],
  };
  const sources: string[] = [];
  const full = buildLlmTranscript(input, (id) => sources.push(id));
  assertEquals(full.map((item) => item.role), ["tool", "user"]);
  assertEquals(sources, ["receipt", "answer"]);
  const prefix = buildLlmTranscript({ ...input, messageIds: ["answer"] });
  assertEquals(prefix.map((item) => item.role), ["user"]);
  assertEquals(prefix[0].content, answer.content);
  const tail = buildLlmTranscript({ ...input, messageIds: ["receipt"] });
  assertEquals(tail.map((item) => item.role), ["tool"]);
  assertEquals(buildLlmTranscript({ ...input, history: [answer] }), prefix);
  assertEquals(buildLlmTranscript({ ...input, history: [receipt] }), tail);
  assertEquals(
    buildLlmTranscript({ ...input, participantId: "west", history: [answer] }),
    [],
  );
});

Deno.test("result-only history preserves tool execution identity after consolidation", () => {
  const transcript = buildLlmTranscript({
    threadId: "thread",
    participantId: "north",
    history: [result("result", "old-plan")],
  });
  assertEquals(transcript.length, 1);
  assertEquals(transcript[0].role, "tool");
  if (transcript[0].role === "tool") {
    assertEquals(transcript[0].toolCallId, "shared");
    assertEquals(transcript[0].toolPlanId, "old-plan");
  }
});
