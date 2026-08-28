import { assertEquals, assertRejects } from "@std/assert";

import { defineCoreToolActionMetadata } from "../../core/internal/workflow-metadata.ts";
import { resolveScheduledRecipientSelection } from "./recipients.ts";

const participants = new Map<string, Record<string, unknown>>([
  [
    "agent-caller",
    {
      id: "agent-caller",
      externalId: "caller",
      participantType: "agent",
    },
  ],
  [
    "agent-other",
    {
      id: "agent-other",
      externalId: "other-external",
      participantType: "agent",
    },
  ],
  [
    "human-a",
    { id: "human-a", externalId: "human", participantType: "human" },
  ],
]);

const threads = new Map<string, Record<string, unknown>>([
  [
    "thread-a",
    {
      id: "thread-a",
      externalId: "thread-external",
      participantIds: ["human-a", "agent-caller", "agent-other"],
    },
  ],
]);

function context(metadata: Readonly<Record<string, unknown>>) {
  const collection = (values: Map<string, Record<string, unknown>>) => ({
    get: ({ id }: { id: string }) => Promise.resolve(values.get(id) ?? null),
    queries: {
      byExternalId: ({ externalId }: { externalId: string }) =>
        Promise.resolve(
          [...values.values()].filter((value) =>
            value.externalId === externalId
          ),
        ),
    },
  });
  return {
    action: { metadata },
    collections: {
      participant: collection(participants),
      thread: collection(threads),
    },
    resources: {
      agents: {
        configured: {
          id: "configured-agent",
          name: "Configured Agent",
          role: "Fixture",
        },
      },
    },
  };
}

const toolMetadata = defineCoreToolActionMetadata({
  schema: "copilotz.core.tool-action.v1",
  planId: "plan-a",
  planMessageId: "plan-message-a",
  planIndex: 0,
  stageIndex: 0,
  stageCount: 1,
  planSize: 1,
  toolCallId: "call-a",
  action: "scheduled_jobs",
  threadId: "thread-a",
  triggerMessageId: "trigger-a",
  agentId: "caller",
  agentParticipantId: "agent-caller",
  initiatorParticipantId: "human-a",
  availableToolIds: ["scheduled_jobs"],
  responseVisibility: { kind: "public" },
  parentLlmActionRunId: "llm-a",
});

Deno.test("scheduled recipient selections snapshot caller, all, and explicit identities", async () => {
  const runtime = context(toolMetadata);
  assertEquals(
    await resolveScheduledRecipientSelection(
      "caller",
      { id: "thread-a" },
      runtime as never,
    ),
    ["agent-caller"],
  );
  assertEquals(
    await resolveScheduledRecipientSelection(
      "all",
      { externalId: "thread-external" },
      runtime as never,
    ),
    ["agent-caller", "agent-other"],
  );
  assertEquals(
    await resolveScheduledRecipientSelection(
      ["other-external", "configured agent"],
      { id: "thread-a" },
      runtime as never,
    ),
    ["agent-other", "configured-agent"],
  );
});

Deno.test("caller selection fails without trusted Tool provenance", async () => {
  await assertRejects(
    () =>
      resolveScheduledRecipientSelection(
        "caller",
        { id: "thread-a" },
        context({}) as never,
      ),
    TypeError,
    "requires trusted Core Tool provenance",
  );
});
