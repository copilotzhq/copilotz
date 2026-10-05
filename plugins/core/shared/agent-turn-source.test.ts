import { assertEquals, assertRejects } from "@std/assert";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  agentTurnSourceDigest,
  resolveAgentTurnSource,
} from "./agent-turn-source.ts";
import {
  type CoreAgentTurnMetadata,
  coreAgentTurnMetadata,
} from "./workflow-metadata.ts";

Deno.test("private source references survive JSON key order and reject changed or foreign roots", async () => {
  const source = { messages: [], context: [], branch: "null" };
  const base: CoreAgentTurnMetadata = {
    schema: "copilotz.core.agent-turn.v1",
    id: "scope",
    ownerParticipantId: "north",
    history: "scope",
    completeOn: { action: "finish" },
  };
  const turn = {
    ...base,
    sourceHistoryRef: {
      messageId: "root",
      digest: await agentTurnSourceDigest(source),
    },
  };
  const root = {
    id: "root",
    namespace: "tenant",
    threadId: "thread",
    historyScopeId: "scope",
    visibility: { kind: "internal" },
    recipientIds: ["north"],
    metadata: {
      copilotzAgentTurn: {
        ...base,
        sourceHistory: { branch: "null", context: [], messages: [] },
      },
    },
  } as unknown as CollectionRecord;
  const scope = {
    namespace: "tenant",
    threadId: "thread",
    participantId: "north",
  };
  assertEquals(await resolveAgentTurnSource(turn, [root], scope), source);
  for (
    const change of [
      { namespace: "other" },
      { threadId: "other" },
      { historyScopeId: "other" },
      { recipientIds: ["south"] },
      { visibility: { kind: "public" } },
      {
        metadata: {
          copilotzAgentTurn: {
            ...base,
            sourceHistory: { ...source, branch: "changed" },
          },
        },
      },
    ]
  ) {
    await assertRejects(
      () => resolveAgentTurnSource(turn, [{ ...root, ...change }], scope),
      Error,
      "source reference",
    );
  }
  await assertRejects(
    () => resolveAgentTurnSource(turn, [], scope),
    Error,
    "source reference",
  );
  assertEquals(
    await resolveAgentTurnSource({ ...base, sourceHistory: source }, [], scope),
    source,
    "legacy inline sources still replay",
  );
  assertEquals(
    coreAgentTurnMetadata({
      copilotzAgentTurn: { ...turn, sourceHistory: source },
    }),
    null,
  );
  assertEquals(
    coreAgentTurnMetadata({
      copilotzAgentTurn: { ...turn, sourceHistoryRef: { messageId: "root" } },
    }),
    null,
  );
});

Deno.test("source integrity uses canonical content references rather than hydrated values", async () => {
  const ref = {
    assetId: "asset",
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain",
    byteLength: 1,
    digest: `sha256:${"a".repeat(64)}`,
  };
  const source = {
    messages: [],
    branch: "null",
    context: [{
      id: "context",
      resourceId: "context",
      title: "Context",
      role: "context" as const,
      capturedAt: "2026-10-05",
      content: [ref],
    }],
  };
  const hydrated = {
    ...source,
    context: [{
      ...source.context[0]!,
      content: [{ ...ref, value: "resolved body", resolve: true }],
    }],
  };
  assertEquals(
    await agentTurnSourceDigest(hydrated),
    await agentTurnSourceDigest(source),
  );
});
