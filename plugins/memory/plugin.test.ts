/** Native Agent-turn composition and integration contract for semantic memory. @module */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  corePlugin,
  defineAgent,
  defineContextResource,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import {
  createPluginRegistry,
  definePlugin,
} from "../../runtime/plugins/index.ts";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import { createSqlSession } from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { projectMessages } from "../core/internal/testing/projections.ts";
import { createTestDomainContext } from "../core/internal/testing/context.ts";
import { createLongTermMemoryPlugin } from "./plugin.ts";

const NAMESPACE = "tenant-memory-native-turn";
const SCHEMA = "copilotz_memory_native_turn";

type Script = (input: LlmAdapterCallInput, index: number) =>
  | LlmAdapterResult
  | Promise<LlmAdapterResult>;

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  inputs: readonly LlmAdapterCallInput[];
  close(): Promise<void>;
}>;

function stop(text: string): LlmAdapterResult {
  return {
    content: { type: "text", role: "body", text },
    attempts: [{ status: "completed" }],
    finishReason: "stop",
  };
}

function tool(input: unknown): LlmAdapterResult {
  return {
    content: [],
    toolCalls: [{
      id: "consolidate-memory",
      action: "consolidate_memory",
      input: input as never,
    }],
    attempts: [{ status: "completed" }],
    finishReason: "tool_calls",
  };
}

function adapter(script: Script, inputs: LlmAdapterCallInput[]): LlmAdapter {
  return Object.freeze({
    call(input) {
      const result = Promise.resolve().then(() =>
        script(input, inputs.push(input))
      );
      return Object.freeze({
        frames: new ReadableStream({
          async start(controller) {
            try {
              await result;
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        }),
        result,
      });
    },
  });
}

function memoryProposal() {
  return {
    outcome: "changes",
    entities: [{
      localId: "compass",
      kind: "entity.project",
      summary: "Compass is the active project.",
      name: "Compass",
      // Deliberately omitted: sources default to the checkpoint's trusted range.
    }],
  };
}

function text(input: LlmAdapterCallInput): string {
  return input.request.messages.flatMap((message) =>
    message.content.map((part) => part.type === "text" ? part.text : "")
  ).join("\n");
}

async function fixture(
  script: Script,
  options: Readonly<{ enabled?: boolean }> = {},
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const inputs: LlmAdapterCallInput[] = [];
  const memory = createLongTermMemoryPlugin({
    enabled: options.enabled,
    config: { triggerEstimatedTokens: 1, retainRecentEstimatedTokens: 0 },
  });
  const app = definePlugin({
    id: "test.memory-native-agent-turn",
    version: "1.0.0",
    resources: {
      agents: {
        north: defineAgent({
          id: "north",
          name: "North",
          role: "assistant",
          instructions: "NORTH_NATIVE_MEMORY_INSTRUCTIONS",
          models: { generate: ["test_model"] },
          capabilities: { tools: ["consolidate_memory"] },
        }),
      },
      models: {
        test_model: { adapter: "test", model: "native-memory-model" },
      },
      promptContext: {
        fixture: defineContextResource({
          id: "fixture.context",
          type: "context",
          purposes: ["conversation"],
          contribute: () => ({
            id: "fixture-context",
            title: "Fixture context",
            role: "context",
            content: "NATIVE_MEMORY_CONTEXT",
          }),
        }),
      },
    },
    adapters: { llm: { test: adapter(script, inputs) } },
  });
  const registry = await createPluginRegistry({ plugins: [memory, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
  });
  return Object.freeze({
    db,
    engine,
    inputs,
    async close() {
      await engine.shutdown();
      await db.close();
    },
  });
}

// The test creates several distinct schema collections through the same real
// registry; this narrow dynamic bridge keeps the fixture itself concise.
// deno-lint-ignore no-explicit-any
function collection(fixture: Fixture, name: string): any {
  const scoped = fixture.engine.collections.withScope({
    namespace: NAMESPACE,
  }) as unknown as Readonly<
    Record<string, unknown>
  >;
  const value = scoped[name];
  if (!value) {
    throw new Error(`Missing '${name}' collection.`);
  }
  return value as never;
}

async function startUserTurn(fixture: Fixture, id = "message:user") {
  const participants = collection(fixture, "participant");
  const threads = collection(fixture, "thread");
  const messages = collection(fixture, "message");
  await participants.create({
    id: "human-a",
    externalId: "human-a",
    participantType: "human",
  }, { namespace: NAMESPACE });
  await participants.create({
    id: "agent-north",
    externalId: "north",
    participantType: "agent",
    agentId: "north",
    name: "North",
  }, { namespace: NAMESPACE });
  await threads.create({
    id: "thread-a",
    participantIds: ["human-a", "agent-north"],
  }, { namespace: NAMESPACE });
  const content = await fixture.engine.content.preparer.prepare(
    "Remember Compass and answer normally.",
    { namespace: NAMESPACE, idempotencyKey: `${id}:content` },
  );
  const created = await messages.create({
    id,
    threadId: "thread-a",
    senderId: "human-a",
    recipientIds: ["agent-north"],
    content,
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread-a",
    routing: { senderId: "human-a", recipientIds: ["agent-north"] },
    identity: { deduplicationId: `${id}:create` },
  });
  return created.id;
}

async function eventually(
  fixture: Fixture,
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await fixture.engine.recover({ namespace: NAMESPACE });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const deadLetters = await fixture.engine.deliveries.list({
    namespace: NAMESPACE,
    status: "dead_letter",
  });
  throw new Error(
    `Memory native turn did not settle: ${JSON.stringify(deadLetters)}`,
  );
}

async function checkpoints(fixture: Fixture) {
  return await collection(fixture, "long_term_memory").list({
    limit: 10,
  });
}

async function checkpoint(fixture: Fixture) {
  const entries = await checkpoints(fixture);
  assertEquals(entries.length, 1);
  return entries[0]!;
}

async function assertNoDeadLetters(fixture: Fixture) {
  assertEquals(
    await fixture.engine.deliveries.list({
      namespace: NAMESPACE,
      status: "dead_letter",
    }),
    [],
  );
}

Deno.test("memory composes Core-native dispatch and settlement without a model selector", () => {
  const plugin = createLongTermMemoryPlugin({
    config: { triggerEstimatedTokens: 1 },
  });
  assertEquals(plugin.plugins, [corePlugin]);
  assertEquals(Object.keys(plugin.actions).sort(), [
    "consolidate_memory",
    "inspect_memory",
    "list_knowledge_spaces",
    "search_memory",
    "set_memory_status",
  ]);
  assertEquals(Object.keys(plugin.processors).sort(), [
    "dispatchConsolidation",
    "reserveMemory",
    "settleConsolidation",
  ]);
});

Deno.test("checkpoint dispatch is a hidden ordinary Agent turn that atomically commits trusted memory", async () => {
  const run = await fixture((_input, call) =>
    call === 1 ? stop("I will remember that.") : tool(memoryProposal())
  );
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );

    assertEquals(run.inputs.length, 2);
    const maintenance = run.inputs[1]!;
    assertEquals(maintenance.model, "test_model");
    assertEquals(maintenance.providerModel, "native-memory-model");
    assertStringIncludes(
      maintenance.request.instructions ?? "",
      "NORTH_NATIVE_MEMORY_INSTRUCTIONS",
    );
    assertStringIncludes(text(maintenance), "NATIVE_MEMORY_CONTEXT");
    assertEquals(maintenance.request.tools?.map((value) => value.name), [
      "consolidate_memory",
    ]);
    assertEquals((await checkpoint(run)).status, "ready");
    const records = await collection(run, "memory_record").list({
      limit: 10,
    });
    assertEquals(records.length, 1);
    const sources = (records[0]!.provenance as {
      sources: readonly { type: string; id: string }[];
    }).sources;
    assertEquals(sources.length, 2);
    assert(sources.some((source) => source.type === "message"));
    assert(sources.some((source) => source.type === "asset"));
    const publicHistory = await projectMessages(
      run.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(publicHistory.length, 2);
    assertEquals(publicHistory[0]?.id, "message:user");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("invalid and omitted consolidation calls repair through ordinary Core continuations", async () => {
  const run = await fixture((_input, call) => {
    if (call === 1) return stop("Initial answer.");
    if (call === 2) return tool({ outcome: "changes" }); // Invalid: no draft.
    if (call === 3) return stop("I forgot the requested tool."); // Memory emits one repair Message.
    return tool(memoryProposal());
  });
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    assertEquals(run.inputs.length, 4);
    assert(
      run.inputs[2]!.request.messages.some((message) =>
        message.role === "tool"
      ),
    );
    assertStringIncludes(text(run.inputs[2]!), "consolidate_memory");
    assertStringIncludes(text(run.inputs[3]!), "Call consolidate_memory now");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("provider failure settles the detached checkpoint as failed", async () => {
  const run = await fixture((_input, call) => {
    if (call === 1) return stop("Initial answer.");
    throw new Error("fixture provider unavailable");
  });
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "failed",
    );
    const saved = await checkpoint(run);
    assertEquals(saved.status, "failed");
    assert(saved.error);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("disabled maintenance leaves dynamically called consolidation as an ordinary continuing Tool turn", async () => {
  const run = await fixture(
    (_input, call) =>
      call === 1
        ? tool(memoryProposal())
        : stop("Memory committed; normal reply continues."),
    { enabled: false },
  );
  try {
    await startUserTurn(run);
    await eventually(run, async () => {
      const saved = (await checkpoints(run))[0];
      const publicMessages = await projectMessages(
        run.engine,
        NAMESPACE,
        "thread-a",
      );
      return saved?.status === "ready" && publicMessages.length === 4;
    });
    const saved = await checkpoint(run);
    assertEquals((saved.metadata as { onDemand?: boolean }).onDemand, true);
    assertEquals(run.inputs.length, 2);
    const publicHistory = await projectMessages(
      run.engine,
      NAMESPACE,
      "thread-a",
    );
    const final = await run.engine.content.resolver.getMany(
      publicHistory.at(-1)!.content,
      { namespace: NAMESPACE },
    );
    assertStringIncludes(final[0]?.text ?? "", "Memory committed");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a direct forged Agent-turn provenance cannot select a checkpoint", async () => {
  const run = await fixture(() => stop("No routing needed."), {
    enabled: false,
  });
  try {
    await startUserTurn(run);
    await collection(run, "long_term_memory").create({
      id: "memory:forged",
      threadId: "thread-a",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "pending",
      sequence: 1,
      agentId: "north",
      sourceStartMessageId: "message:user",
      sourceEndMessageId: "message:user",
      content: [],
      contextSnapshotContent: [],
      contextSnapshot: null,
      embedding: null,
      contentHash: null,
      tokenEstimate: null,
      error: null,
      metadata: { agentParticipantId: "agent-north" },
    });
    const context = createTestDomainContext(run.engine, NAMESPACE);
    const forged = {
      schema: "copilotz.core.tool-action.v1",
      planId: "forged-plan",
      planMessageId: "forged-message",
      planIndex: 0,
      stageIndex: 0,
      stageCount: 1,
      planSize: 1,
      toolCallId: "forged-call",
      action: "consolidate_memory",
      threadId: "thread-a",
      triggerMessageId: "forged-trigger",
      agentId: "north",
      agentParticipantId: "agent-north",
      initiatorParticipantId: "human-a",
      availableToolIds: ["consolidate_memory"],
      responseVisibility: { kind: "public" },
      parentLlmActionRunId: "forged-llm",
      agentTurn: {
        schema: "copilotz.core.agent-turn.v1",
        id: "memory:forged",
        ownerParticipantId: "agent-north",
        completeOn: { action: "consolidate_memory" },
      },
    };
    await assertRejects(
      () =>
        context.actions.consolidate_memory(memoryProposal(), {
          operationKey: "forged-consolidation",
          metadata: forged,
        }),
      Error,
      "does not own this checkpoint",
    );
    assertEquals((await checkpoint(run)).status, "pending");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});
