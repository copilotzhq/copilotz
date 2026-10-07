import { assert, assertEquals } from "@std/assert";
import type { ConversationMessage } from "@copilotz/copilotz/core";
import {
  type AgentAskMetadata,
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  type CoreToolActionOrigin,
  withAgentAskMetadata,
  withAgentAskResultMetadata,
  withCoreToolActionMessageMetadata,
  withCoreToolPlanMetadata,
} from "../../core/shared/workflow-metadata.ts";
import { sourceCatalog, toolSourceHandle } from "./evidence.ts";
const STAMP = "2026-09-08T00:00:00.000Z";

type Sender = ConversationMessage["sender"];

function participant(
  id: string,
  name: string,
  participantType: Sender["participantType"],
): Sender {
  return {
    id,
    namespace: "tenant",
    externalId: id,
    participantType,
    name,
    metadata: {},
    createdAt: STAMP,
    updatedAt: STAMP,
  } as Sender;
}

const ana = participant("ana", "Ana", "human");
const north = participant("north", "North", "agent");
const south = participant("south", "South", "agent");
const tool = participant("tool", "tool", "tool");

function text(value: string) {
  return {
    kind: "text",
    role: "body",
    mediaType: "text/plain; charset=utf-8",
    value,
  };
}

function message(
  id: string,
  sender: Sender,
  body: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return {
    id,
    namespace: "tenant",
    threadId: "thread",
    sender,
    recipientIds: [],
    content: body ? [text(body)] : [],
    metadata,
    createdAt: STAMP,
    updatedAt: STAMP,
  } as unknown as ConversationMessage;
}

function origin(
  planId: string,
  toolCallId: string,
  action: string,
): CoreToolActionOrigin {
  return {
    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
    planId,
    planMessageId: `message:${planId}`,
    planIndex: 0,
    stageIndex: 0,
    stageCount: 1,
    planSize: 1,
    toolCallId,
    action,
    threadId: "thread",
    triggerMessageId: "trigger",
    agentId: "north",
    agentParticipantId: "north",
    initiatorParticipantId: "ana",
    availableToolIds: [action],
    responseVisibility: { kind: "public" },
    parentLlmActionRunId: `llm:${planId}`,
  };
}

function toolPlan(
  id: string,
  sender: Sender,
  body: string,
  planId: string,
  calls: readonly { id: string; action: string; input: object }[],
  extra: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return message(
    id,
    sender,
    body,
    withCoreToolPlanMetadata({ ...extra, llmToolCalls: calls }, {
      schema: CORE_TOOL_PLAN_METADATA_SCHEMA,
      planId,
      planSize: calls.length,
    }),
  );
}

function toolResult(
  id: string,
  body: string,
  planId: string,
  toolCallId: string,
  action: string,
  extra: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return message(
    id,
    tool,
    body,
    withCoreToolActionMessageMetadata(
      {
        requesterId: "north",
        historyVisibility: "public_status",
        toolStatus: "completed",
        toolId: action,
        ...extra,
      },
      origin(planId, toolCallId, action),
      `run:${id}`,
    ),
  );
}

function askConversation(mode: "public" | "private") {
  const ask = (phase: AgentAskMetadata["phase"]): AgentAskMetadata => ({
    schema: "copilotz.ask.v1",
    askId: "ask-1",
    phase,
    mode,
    toolActionRunId: "run:ask",
    toolCallId: "ask-call",
    questionMessageId: "q1",
    askingParticipantId: "north",
    askingAgentId: "north",
    askingAgentName: "North",
    askedParticipantId: "south",
    askedAgentId: "south",
    askedAgentName: "South",
    origin: origin("plan-ask", "ask-call", "ask"),
    depth: 1,
  });
  return [
    message("h1", ana, "North, get South's budget estimate."),
    toolPlan("n1", north, "", "plan-ask", [{
      id: "ask-call",
      action: "ask",
      input: { agent: "south", question: "Budget estimate?" },
    }]),
    message(
      "q1",
      north,
      "What is your budget estimate?",
      withAgentAskMetadata({}, ask("question")),
    ),
    message(
      "a1",
      south,
      "About $10k.",
      withAgentAskMetadata({}, ask("answer")),
    ),
    toolResult(
      "r1",
      "",
      "plan-ask",
      "ask-call",
      "ask",
      withAgentAskResultMetadata({}, {
        schema: "copilotz.ask-result.v1",
        askId: "ask-1",
        status: "completed",
        askedParticipantId: "south",
        askedAgentId: "south",
        answerMessageId: "a1",
      }),
    ),
    message("n2", north, "South estimates $10k."),
  ];
}

Deno.test("memory source handles follow participant-visible bodies and successful results", () => {
  const own = toolResult("own", "own result", "p", "c", "weather");
  const failed = toolResult("failed", "error", "p", "failed", "weather", {
    toolStatus: "failed",
  });
  const hidden = toolResult("hidden", "private", "hidden", "c", "weather", {
    requesterId: "south",
    historyVisibility: "requester_only",
  });
  const status = toolResult("status", "status body", "status", "c", "weather", {
    requesterId: "south",
    historyVisibility: "public_status",
  });
  const publicResult = toolResult(
    "public",
    "public body",
    "public",
    "c",
    "weather",
    { requesterId: "south", historyVisibility: "public" },
  );
  const human = {
    ...message("human", ana, "Visible", {
      llmReasoning: [{ assetId: "thought" }],
    }),
    content: [
      {
        assetId: "inline",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
      {
        assetId: "file",
        kind: "file",
        role: "attachment",
        mediaType: "application/pdf",
      },
      {
        assetId: "attached",
        kind: "text",
        disposition: "attachment",
        role: "body",
        mediaType: "text/plain",
      },
    ],
  } as ConversationMessage;
  const catalog = sourceCatalog(
    [human, own, failed, hidden, status, publicResult],
    [],
    "north",
  );
  for (
    const handle of [
      "message:human",
      "asset:inline",
      "message:own",
      "message:public",
      toolSourceHandle("p", "c"),
    ]
  ) assert(catalog.has(handle), handle);
  for (
    const handle of [
      "asset:thought",
      "asset:file",
      "asset:attached",
      "message:failed",
      "message:hidden",
      "message:status",
      toolSourceHandle("p", "failed"),
    ]
  ) assert(!catalog.has(handle), handle);
});

Deno.test("Ask evidence names the received answer body instead of its receipt", () => {
  for (const mode of ["public", "private"] as const) {
    const catalog = sourceCatalog(askConversation(mode), [], "north");
    assertEquals(catalog.get(toolSourceHandle("plan-ask", "ask-call")), {
      type: "message",
      id: "a1",
    });
    assertEquals(catalog.has("message:r1"), false);
  }
  const peer = sourceCatalog(askConversation("private"), [], "unrelated");
  assertEquals(peer.has("message:a1"), false);
});

Deno.test("repeated tool-call IDs are scoped to plans and ambiguous duplicate handles are rejected", () => {
  const results = [
    toolResult("a", "a", "p1", "call", "weather"),
    toolResult("b", "b", "p2", "call", "weather"),
  ];
  const catalog = sourceCatalog([], [], "north", results);
  assertEquals(catalog.get(toolSourceHandle("p1", "call"))?.id, "a");
  assertEquals(catalog.get(toolSourceHandle("p2", "call"))?.id, "b");
  const duplicate = sourceCatalog(
    [...results, toolResult("c", "c", "p1", "call", "weather")],
    [],
    "north",
  );
  assertEquals(duplicate.has(toolSourceHandle("p1", "call")), false);
});
