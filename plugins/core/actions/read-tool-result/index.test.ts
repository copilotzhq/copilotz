import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { readToolResultAction } from "./index.ts";
import type { CoreActionContext } from "../../shared/runtime-context.ts";
import {
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  defineCoreToolActionMetadata,
  withCoreToolActionMessageMetadata,
} from "../../shared/workflow-metadata.ts";

const bytes = new TextEncoder().encode("first .*beta$ literal and more text");
const visibility = {
  kind: "tool",
  policy: "requester_only",
  requesterId: "agent-participant",
};

function origin(action: string) {
  return defineCoreToolActionMetadata({
    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
    planId: "plan",
    planMessageId: "plan-message",
    planIndex: 0,
    stageIndex: 0,
    stageCount: 1,
    planSize: 1,
    toolCallId: `call-${action}`,
    action,
    threadId: "thread",
    triggerMessageId: "trigger",
    agentId: "agent",
    agentParticipantId: "agent-participant",
    initiatorParticipantId: "human",
    availableToolIds: ["search", "readToolResult"],
    responseVisibility: { kind: "public" },
    parentLlmActionRunId: "llm-run",
  });
}

function fixture() {
  const searchOrigin = defineCoreToolActionMetadata({
    ...origin("search"),
  });
  const metadata = withCoreToolActionMessageMetadata(
    {
      requesterId: "agent-participant",
      historyVisibility: "requester_only",
      toolStatus: "completed",
      toolInvocation: { id: "search-call", tool: { id: "search" } },
      copilotzWorkflow: {
        kind: "tool_result",
        agentParticipantId: "agent-participant",
      },
    },
    searchOrigin,
    "search-run",
  );
  const message = {
    id: "large-result",
    namespace: "tenant",
    threadId: "thread",
    senderId: "tool-participant",
    content: [{
      assetId: "large-body",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
    }],
    metadata,
    visibility,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as CollectionRecord;
  const actionContext = {
    namespace: "tenant",
    resources: {
      agents: {
        agent: { id: "agent", name: "Agent", role: "worker", models: {} },
      },
      toolResults: {
        default: {
          maxInlineBytes: 4096,
          maxReadBytes: 128,
          maxSourceBytes: 1024,
        },
      },
    },
    action: {
      id: "copilotz.core.read-tool-result",
      metadata: origin("readToolResult"),
    },
    collections: {
      thread: {
        get: () =>
          Promise.resolve({
            id: "thread",
            participantIds: ["agent-participant", "human"],
          }),
      },
      participant: {
        get: ({ id }: { id: string }) =>
          Promise.resolve(
            id === "agent-participant"
              ? { id, participantType: "agent", agentId: "agent" }
              : id === "tool-participant"
              ? { id, participantType: "tool" }
              : null,
          ),
      },
      message: {
        queries: {
          history: () => Promise.resolve([message]),
        },
        get: () => Promise.resolve(message),
      },
    },
    content: {
      getMany: (ids: readonly string[]) =>
        Promise.resolve(
          ids.includes("large-body")
            ? [{ id: "large-body", byteLength: bytes.byteLength }]
            : [],
        ),
      resolveMany: (refs: readonly Record<string, unknown>[]) =>
        Promise.resolve(refs.map((ref) => ({
          ref: ref as never,
          asset: { id: "large-body", byteLength: bytes.byteLength } as never,
          bytes,
          text: new TextDecoder().decode(bytes),
        }))),
    },
  } as unknown as CoreActionContext;
  return { message, actionContext };
}

Deno.test("readToolResult applies a bounded literal search over authorized result bytes", async () => {
  const { actionContext } = fixture();
  const result = await readToolResultAction.execute({
    messageId: "large-result",
    offset: 0,
    limit: 8,
    search: ".*beta$",
  }, actionContext);
  assertEquals(result.found, true);
  assertEquals(result.content, ".*beta$ ");
  assertEquals(result.sourceBytes, bytes.byteLength);
  assertEquals(result.totalBytes, bytes.byteLength);
  assertEquals(
    result.matchOffset,
    new TextDecoder().decode(bytes).indexOf(".*beta$"),
  );
  assert(result.content.length <= result.limit);

  const next = await readToolResultAction.execute({
    messageId: "large-result",
    offset: result.nextOffset,
    limit: 10,
  }, actionContext);
  assertStringIncludes(next.content, "literal");
});

Deno.test("readToolResult denies requester-only bodies owned by another Agent", async () => {
  const { message, actionContext } = fixture();
  const other = {
    ...message,
    metadata: {
      ...(message.metadata as Record<string, unknown>),
      requesterId: "other-participant",
      copilotzWorkflow: {
        kind: "tool_result",
        agentParticipantId: "other-participant",
      },
      copilotzToolAction:
        withCoreToolActionMessageMetadata({}, origin("search"), "other-run")
          .copilotzToolAction,
    },
    visibility: {
      kind: "tool",
      policy: "requester_only",
      requesterId: "other-participant",
    },
  } as CollectionRecord;
  const context = {
    ...actionContext,
    collections: {
      ...actionContext.collections,
      message: {
        queries: { history: () => Promise.resolve([other]) },
        get: () => Promise.resolve(other),
      },
    },
  } as unknown as CoreActionContext;
  await assertRejects(
    async () =>
      await readToolResultAction.execute(
        { messageId: "large-result" },
        context,
      ),
    Error,
    "unavailable to this Agent",
  );
});

Deno.test("readToolResult cannot bypass public_status redaction with exact-ID fallback", async () => {
  const { message, actionContext } = fixture();
  const publicStatus = {
    ...message,
    content: [],
    visibility: {
      kind: "tool",
      policy: "public_status",
      requesterId: "agent-participant",
    },
    metadata: {
      toolStatus: "completed",
      toolId: "search",
      toolInvocation: { id: "search-call", tool: { id: "search" } },
      copilotzWorkflow: { sourceMessageId: "trigger" },
      copilotzToolAction: {
        actionRunId: "search-run",
        planMessageId: "plan-message",
      },
    },
  } as CollectionRecord;
  let bodyLookups = 0;
  const context = {
    ...actionContext,
    collections: {
      ...actionContext.collections,
      message: {
        queries: { history: () => Promise.resolve([publicStatus]) },
        // A private direct read must not replace a redacted history projection.
        get: () => Promise.resolve(message),
      },
    },
    content: {
      ...actionContext.content,
      getMany: (...args: Parameters<typeof actionContext.content.getMany>) => {
        bodyLookups++;
        return actionContext.content.getMany(...args);
      },
    },
  } as unknown as CoreActionContext;
  await assertRejects(
    async () =>
      await readToolResultAction.execute(
        { messageId: "large-result" },
        context,
      ),
    Error,
    "unavailable to this Agent",
  );
  assertEquals(bodyLookups, 0);
});

Deno.test("readToolResult accounts for JSON escaping under the inline byte limit", async () => {
  const { message, actionContext } = fixture();
  const escapable = new TextEncoder().encode("\u0000".repeat(3_000));
  const context = {
    ...actionContext,
    resources: {
      ...actionContext.resources,
      toolResults: {
        default: {
          maxInlineBytes: 4_096,
          maxReadBytes: 8_192,
          maxSourceBytes: 8_192,
        },
      },
    },
    content: {
      getMany: () =>
        Promise.resolve([{ id: "large-body", byteLength: escapable.length }]),
      resolveMany: (refs: readonly Record<string, unknown>[]) =>
        Promise.resolve(refs.map((ref) => ({
          ref: ref as never,
          asset: { id: "large-body", byteLength: escapable.length } as never,
          bytes: escapable,
          text: "\u0000".repeat(3_000),
        }))),
    },
  } as unknown as CoreActionContext;
  const result = await readToolResultAction.execute({
    messageId: "large-result",
    limit: 8_192,
  }, context);
  assert(result.content.length > 0);
  assert(result.nextOffset > result.offset);
  assert(
    new TextEncoder().encode(JSON.stringify(result)).byteLength + 512 <=
      4_096,
  );
  assertStringIncludes(result.content, "\u0000");
});

Deno.test("readToolResult rejects a literal match that cannot fit in its bounded output", async () => {
  const { message, actionContext } = fixture();
  const longLiteral = "€".repeat(512);
  const body = new TextEncoder().encode(longLiteral);
  const context = {
    ...actionContext,
    resources: {
      ...actionContext.resources,
      toolResults: {
        default: {
          maxInlineBytes: 2_048,
          maxReadBytes: 8_192,
          maxSourceBytes: 8_192,
        },
      },
    },
    content: {
      getMany: () =>
        Promise.resolve([{ id: "large-body", byteLength: body.length }]),
      resolveMany: (refs: readonly Record<string, unknown>[]) =>
        Promise.resolve(refs.map((ref) => ({
          ref: ref as never,
          asset: { id: "large-body", byteLength: body.length } as never,
          bytes: body,
          text: longLiteral,
        }))),
    },
  } as unknown as CoreActionContext;
  const utf8Message = {
    ...message,
    content: [{
      ...(message.content as readonly Record<string, unknown>[])[0],
    }],
  } as CollectionRecord;
  const utf8Context = {
    ...context,
    collections: {
      ...context.collections,
      message: {
        queries: { history: () => Promise.resolve([utf8Message]) },
        get: () => Promise.resolve(utf8Message),
      },
    },
  } as unknown as CoreActionContext;
  await assertRejects(
    async () =>
      await readToolResultAction.execute({
        messageId: "large-result",
        search: longLiteral,
      }, utf8Context),
    RangeError,
    "longer than one Tool result read",
  );
});

Deno.test("readToolResult rejects a limit too small to include the next UTF-8 character", async () => {
  const { message, actionContext } = fixture();
  const euro = new TextEncoder().encode("€");
  const context = {
    ...actionContext,
    content: {
      getMany: () =>
        Promise.resolve([{ id: "large-body", byteLength: euro.length }]),
      resolveMany: (refs: readonly Record<string, unknown>[]) =>
        Promise.resolve(refs.map((ref) => ({
          ref: ref as never,
          asset: { id: "large-body", byteLength: euro.length } as never,
          bytes: euro,
          text: "€",
        }))),
    },
  } as unknown as CoreActionContext;
  const originalContent = message.content as readonly Record<string, unknown>[];
  const utf8Message = {
    ...message,
    content: [{ ...originalContent[0] }],
  } as CollectionRecord;
  const utf8Context = {
    ...context,
    collections: {
      ...context.collections,
      message: {
        queries: { history: () => Promise.resolve([utf8Message]) },
        get: () => Promise.resolve(utf8Message),
      },
    },
  } as unknown as CoreActionContext;
  await assertRejects(
    async () =>
      await readToolResultAction.execute({
        messageId: "large-result",
        limit: 1,
      }, utf8Context),
    TypeError,
    "too small",
  );
});
