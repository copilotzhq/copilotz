import { assertEquals } from "@std/assert";
import type { ApplicationOutput } from "@copilotz/copilotz/application";
import { projectCoreReply } from "./index.ts";

const SCOPE = {
  namespace: "tenant-a",
  correlationId: "correlation-a",
  threadId: "thread-a",
  agentId: "support",
  viewerParticipantIds: ["human-a"],
} as const;

function output(
  overrides: Readonly<Record<string, unknown>> = {},
  envelopeOverrides: Readonly<Record<string, unknown>> = {},
  operation = "create",
): ApplicationOutput {
  const record = {
    id: "message-a",
    namespace: "tenant-a",
    threadId: "thread-a",
    senderId: "agent-a",
    recipientIds: [],
    content: [{
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      text: "Hello",
    }],
    metadata: {
      copilotzWorkflow: {
        kind: "agent_output",
        agentId: "support",
        agentParticipantId: "agent-a",
        initiatorParticipantId: "human-a",
      },
    },
    ...overrides,
  };
  return ({
    durable: true,
    id: "event-a",
    position: "1",
    schemaVersion: 1,
    type: "message.created",
    namespace: "tenant-a",
    subject: { type: "message", id: "message-a" },
    payload: {},
    metadata: {
      core: {
        threadId: "thread-a",
        routing: { senderId: "agent-a", recipientIds: [] },
        visibility: { kind: "public" },
      },
    },
    correlationId: "correlation-a",
    createdAt: "2026-09-22T00:00:00.000Z",
    data: { operation, record },
    ...envelopeOverrides,
  } as unknown) as ApplicationOutput;
}

Deno.test("Core reply projection returns ordered resolved body narration", () => {
  const candidate = output({
    content: [
      {
        assetId: "asset-a",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        text: "Hello",
      },
      {
        assetId: "asset-reasoning",
        kind: "text",
        role: "reasoning",
        mediaType: "text/plain",
        text: "private reasoning",
      },
      {
        assetId: "asset-image",
        kind: "image",
        role: "body",
        mediaType: "image/png",
      },
      {
        assetId: "asset-tool",
        kind: "text",
        role: "tool.output",
        mediaType: "text/plain",
        text: "tool result",
      },
      {
        assetId: "asset-b",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        text: "world",
      },
    ],
    metadata: {
      copilotzWorkflow: {
        kind: "agent_output",
        agentId: "support",
        agentParticipantId: "agent-a",
        initiatorParticipantId: "human-a",
      },
      llmToolCalls: [{ id: "call-a", tool: "lookup" }],
    },
  });
  assertEquals(projectCoreReply(candidate, SCOPE), {
    messageId: "message-a",
    text: "Hello\nworld",
  });
});

Deno.test("Core reply projection accepts remote text and legacy row visibility", () => {
  const candidate = output({
    visibility: undefined,
    content: [{
      assetId: "remote-asset",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      text: "Hydrated remotely",
    }, {
      assetId: "unresolved-asset",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
  });
  assertEquals(projectCoreReply(candidate, SCOPE), {
    messageId: "message-a",
    text: "Hydrated remotely",
  });
});

Deno.test("Core reply projection requires an authorized participant audience", () => {
  const candidate = output({
    visibility: { kind: "participants", participantIds: ["human-a"] },
  });
  assertEquals(
    projectCoreReply(candidate, {
      ...SCOPE,
      viewerParticipantIds: [],
    }),
    null,
  );
  assertEquals(
    projectCoreReply(candidate, {
      ...SCOPE,
      viewerParticipantIds: ["other"],
    }),
    null,
  );
  assertEquals(projectCoreReply(candidate, SCOPE), {
    messageId: "message-a",
    text: "Hello",
  });
  assertEquals(
    projectCoreReply(output({ recipientIds: ["other"] }), SCOPE),
    null,
  );
});

Deno.test("Core reply projection rejects identity, provenance, and private visibility mismatches", () => {
  const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
    ["wrong namespace", { namespace: "other" }],
    ["wrong thread", { threadId: "other" }],
    ["wrong sender", { senderId: "other" }],
    ["private history", { historyScopeId: "turn-private" }],
    ["internal envelope", {}],
  ];
  for (const [name, changes] of cases) {
    const candidate = name === "internal envelope"
      ? output({})
      : output(changes);
    const value = name === "internal envelope"
      ? output({
        metadata: {
          core: {
            threadId: "thread-a",
            routing: { senderId: "agent-a", recipientIds: [] },
            visibility: { kind: "internal" },
          },
        },
      })
      : candidate;
    assertEquals(projectCoreReply(value, SCOPE), null, name);
  }
  assertEquals(
    projectCoreReply(output({}, { namespace: "other" }), SCOPE),
    null,
  );
  assertEquals(
    projectCoreReply(output({}, { correlationId: "other" }), SCOPE),
    null,
  );
  assertEquals(projectCoreReply(output({}, {}, "update"), SCOPE), null);
  assertEquals(
    projectCoreReply(
      output({
        metadata: {
          core: {
            threadId: "thread-a",
            routing: { senderId: "agent-a", recipientIds: [] },
            visibility: { kind: "public" },
          },
        },
      }),
      {
        ...SCOPE,
        agentId: "other-agent",
      },
    ),
    null,
  );
  assertEquals(
    projectCoreReply(
      output({
        metadata: {
          core: {
            threadId: "thread-a",
            routing: { senderId: "agent-a", recipientIds: [] },
            visibility: { kind: "public" },
          },
        },
        visibility: { kind: "tool", policy: "public", requesterId: "human-a" },
      }),
      SCOPE,
    ),
    null,
  );
});
