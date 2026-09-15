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
  withCoreToolPlanMetadata,
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
import AjvModule from "ajv";
import { consolidateMemoryAction } from "./actions/consolidate-memory/index.ts";
import { inspectMemoryAction } from "./actions/inspect-memory/index.ts";
import { searchMemoryAction } from "./actions/search-memory/index.ts";
import { memoryPlugin } from "./plugin.ts";
import type { LongTermMemoryConfig } from "./resources/memory/config/index.ts";

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
    continuity: "Compass remains the active project for the next turn.",
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
  options: Readonly<{
    enabled?: boolean;
    inputLimit?: number;
    memoryConfig?: Partial<LongTermMemoryConfig>;
  }> = {},
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const inputs: LlmAdapterCallInput[] = [];
  const memory = memoryPlugin;
  const app = definePlugin({
    id: "test.memory-native-agent-turn",
    version: "1.0.0",
    resources: {
      memory: {
        config: {
          enabled: options.enabled,
          triggerEstimatedTokens: 1,
          retainRecentEstimatedTokens: 0,
          ...options.memoryConfig,
        },
      },
      agents: {
        north: defineAgent({
          id: "north",
          name: "North",
          role: "assistant",
          instructions: "NORTH_NATIVE_MEMORY_INSTRUCTIONS",
          models: {
            generate: [{
              connection: "test_model",
              model: "native-memory-model",
              ...(options.inputLimit === undefined ? {} : {
                options: { limitEstimatedInputTokens: options.inputLimit },
              }),
            }],
          },
          capabilities: { tools: ["consolidate_memory"] },
        }),
      },
      llmConnections: {
        test_model: { adapter: "test" },
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

async function setupThread(fixture: Fixture) {
  const participants = collection(fixture, "participant");
  const threads = collection(fixture, "thread");
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
}

async function createHumanMessage(
  fixture: Fixture,
  input: Readonly<
    { id: string; text: string; recipientIds?: readonly string[] }
  >,
) {
  const messages = collection(fixture, "message");
  const content = await fixture.engine.content.preparer.prepare(
    input.text,
    { namespace: NAMESPACE, idempotencyKey: `${input.id}:content` },
  );
  const created = await messages.create({
    id: input.id,
    threadId: "thread-a",
    senderId: "human-a",
    recipientIds: input.recipientIds ?? [],
    content,
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread-a",
    routing: { senderId: "human-a", recipientIds: input.recipientIds ?? [] },
    identity: { deduplicationId: `${input.id}:create` },
  });
  return created.id;
}

async function startUserTurn(fixture: Fixture, id = "message:user") {
  await setupThread(fixture);
  return await createHumanMessage(fixture, {
    id,
    text: "Remember Compass and answer normally.",
    recipientIds: ["agent-north"],
  });
}

async function eventually(
  fixture: Fixture,
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
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

function assertConsolidationLifecycleOutput(value: unknown) {
  const validate = new AjvModule.default({ strict: false }).compile(
    consolidateMemoryAction.outputSchema as any,
  );
  assert(validate(value), JSON.stringify(validate.errors));
}

Deno.test("memory composes Core-native dispatch and settlement without a model selector", () => {
  const plugin = memoryPlugin;
  assertEquals(plugin.plugins, [corePlugin]);
  assertEquals(Object.keys(plugin.actions).sort(), [
    "consolidate_memory",
    "inspect_memory",
    "invalidate_memory",
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

    const saved = await checkpoint(run);
    assertEquals(
      run.inputs.length,
      2,
      JSON.stringify({
        error: saved.error,
        metadata: saved.metadata,
        inputs: run.inputs.map((input) => ({
          messages: input.request.messages.length,
          textLength: text(input).length,
        })),
      }),
    );
    const maintenance = run.inputs[1]!;
    assertEquals(maintenance.model, "native-memory-model");
    assertEquals(maintenance.providerModel, "native-memory-model");
    assertStringIncludes(
      maintenance.request.instructions ?? "",
      "NORTH_NATIVE_MEMORY_INSTRUCTIONS",
    );
    const maintenanceText = text(maintenance);
    assertStringIncludes(maintenanceText, "NATIVE_MEMORY_CONTEXT");
    // The maintenance turn receives exactly the reserved source range, rather
    // than the ordinary public reply that follows the triggering message.
    assertStringIncludes(
      maintenanceText,
      "Remember Compass and answer normally.",
    );
    // The ordinary source is embedded in the single maintenance task rather
    // than replayed as separate raw public-history messages.
    assertEquals(maintenance.request.messages.length, 1);
    assertEquals(maintenance.request.messages[0]?.role, "user");
    assertEquals(maintenance.request.tools?.map((value) => value.name), [
      "consolidate_memory",
    ]);
    const savedCheckpoint = await checkpoint(run);
    assertEquals(savedCheckpoint.status, "ready");
    assertEquals(
      (savedCheckpoint.metadata as {
        coverage?: { continuity?: string };
      }).coverage?.continuity,
      "Compass remains the active project for the next turn.",
    );
    assertConsolidationLifecycleOutput(
      (savedCheckpoint.metadata as { result?: unknown }).result,
    );
    const records = await collection(run, "memory_record").list({
      limit: 10,
    });
    assertEquals(records.length, 1);
    const sources = (records[0]!.provenance as {
      sources: readonly { type: string; id: string }[];
    }).sources;
    const publicHistory = await projectMessages(
      run.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(publicHistory.length, 2);
    assertEquals(publicHistory[0]?.id, "message:user");
    const messageSources = sources.filter((source) => source.type === "message")
      .map((source) => source.id).sort();
    assertEquals(
      messageSources,
      publicHistory.map((message) => message.id).sort(),
    );
    assertEquals(sources.filter((source) => source.type === "asset").length, 2);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a no_changes maintenance Action completes with schema-valid continuity", async () => {
  const run = await fixture((_input, call) =>
    call === 1 ? stop("I will remember that.") : tool({
      outcome: "no_changes",
      continuity:
        "Continue the Compass conversation; no durable memory record changed and no user answer is pending.",
    })
  );
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const saved = await checkpoint(run);
    assertEquals(saved.status, "ready");
    assertConsolidationLifecycleOutput(
      (saved.metadata as { result?: unknown }).result,
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("an uncertified legacy checkpoint rebuilds from the raw bounded prefix", async () => {
  const run = await fixture((_input, call) =>
    call === 1 ? stop("I will remember that.") : tool(memoryProposal())
  );
  try {
    await setupThread(run);
    await createHumanMessage(run, {
      id: "message:legacy",
      text: "LEGACY_SOURCE_MUST_BE_REBUILT",
    });
    const spaces = collection(run, "memory_space");
    const grants = collection(run, "memory_space_access");
    await spaces.create({
      id: "space-a",
      name: "Space A",
      scopeType: "thread",
      scopeId: "thread-a",
      threadId: "thread-a",
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await grants.create({
      id: "grant-a",
      threadId: "thread-a",
      memorySpaceId: "space-a",
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await collection(run, "long_term_memory").create({
      id: "legacy-ready",
      threadId: "thread-a",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "ready",
      sequence: 89,
      agentId: "north",
      readMemorySpaceIds: ["space-a"],
      sourceStartMessageId: "message:legacy",
      sourceEndMessageId: "message:legacy",
      content: [],
      contextSnapshotContent: [],
      contextSnapshot: null,
      embedding: null,
      contentHash: null,
      tokenEstimate: null,
      error: null,
      metadata: { agentParticipantId: "agent-north" },
    });
    await createHumanMessage(run, {
      id: "message:current",
      text: "Current request after the legacy checkpoint.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run)).some((item: { id: string; status: string }) =>
          item.id !== "legacy-ready" && item.status === "ready"
        ),
    );
    const maintenance = run.inputs.find((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenance);
    assertStringIncludes(
      text(maintenance),
      "LEGACY_SOURCE_MUST_BE_REBUILT",
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("background compaction reaches its default trigger when one source chunk is smaller", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("The ordinary request can continue."),
    {
      inputLimit: 40_000,
      memoryConfig: { triggerEstimatedTokens: 20_000 },
    },
  );
  try {
    await setupThread(run);
    for (let index = 0; index < 13; index++) {
      await createHumanMessage(run, {
        id: "message:background:" + index,
        text: "BACKGROUND_" + index + " " + "history ".repeat(1_600),
      });
    }
    await createHumanMessage(run, {
      id: "message:background:latest",
      text: "BACKGROUND_LATEST keeps the normal turn active.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run)).some((item: { status: string }) =>
          item.status === "ready"
        ),
    );
    const maintenance = run.inputs.find((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenance);
    assertStringIncludes(text(maintenance), "BACKGROUND_0");
    assertEquals(text(maintenance).includes("BACKGROUND_LATEST"), false);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("an open Ask plan cannot pin the consolidation boundary", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("Continue after compaction."),
    {
      inputLimit: 40_000,
      memoryConfig: { triggerEstimatedTokens: 20_000 },
    },
  );
  try {
    await setupThread(run);
    const content = await run.engine.content.preparer.prepare(
      "OPEN_ASK: South is still working.",
      {
        namespace: NAMESPACE,
        idempotencyKey: "open-ask-content",
      },
    );
    await collection(run, "message").create({
      id: "message:open-ask",
      threadId: "thread-a",
      senderId: "agent-north",
      recipientIds: [],
      content,
      metadata: withCoreToolPlanMetadata({
        llmToolCalls: [{
          id: "ask-south",
          action: "ask",
          input: { target: "south", message: "Investigate." },
        }],
      }, {
        schema: "copilotz.core.tool-plan.v1",
        planId: "unresolved-plan",
        planSize: 1,
      }),
    }, { namespace: NAMESPACE });
    for (let index = 0; index < 13; index++) {
      await createHumanMessage(run, {
        id: `message:progress:${index}`,
        text: `PROGRESS_${index} ${"history ".repeat(1_600)}`,
      });
    }
    await createHumanMessage(run, {
      id: "message:resume",
      text: "Resume.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run)).some((item: { status: string }) =>
          item.status === "ready"
        ),
    );
    const saved = (await checkpoints(run)).find((item: { status: string }) =>
      item.status === "ready"
    );
    assertEquals(saved.sourceStartMessageId, "message:open-ask");
    assert(saved.sourceEndMessageId !== "message:open-ask");
    const maintenance = run.inputs.find((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenance);
    assertStringIncludes(text(maintenance), "OPEN_ASK");
    assertStringIncludes(text(maintenance), "ask-south");
    assertStringIncludes(text(maintenance), "unresolved-plan");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("an oversized normal request compacts a bounded prefix before retrying with continuity and its latest tail", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("The compacted normal request can continue."),
    { inputLimit: 40_000 },
  );
  try {
    await setupThread(run);
    for (let index = 0; index < 26; index++) {
      await createHumanMessage(run, {
        id: `message:old:${index}`,
        text: `OLD_${index} ${"history ".repeat(1_600)}`,
      });
    }
    await createHumanMessage(run, {
      id: "message:latest",
      text: "LATEST_TAIL continue the active task.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () => {
        const values = await checkpoints(run);
        return (values.some((item: { status: string }) =>
          item.status === "ready"
        ) &&
          run.inputs.some((input) =>
            !text(input).includes("Internal memory maintenance")
          )) ||
          values.some((item: { status: string }) =>
            item.status === "failed" || item.status === "cancelled"
          );
      },
    );

    const saved = (await checkpoints(run)).find((item: { status: string }) =>
      item.status === "ready"
    );
    assert(saved);
    const maintenanceInputs = run.inputs.filter((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenanceInputs.length >= 1);
    const maintenance = text(maintenanceInputs[0]!);
    assertStringIncludes(maintenance, "OLD_0");
    assert(!maintenance.includes("LATEST_TAIL"));
    const retriedInput = run.inputs.find((input) =>
      !text(input).includes("Internal memory maintenance")
    )!;
    const retried = text(retriedInput);
    assertStringIncludes(
      retriedInput.request.instructions ?? "",
      "Compass remains the active project",
    );
    assertStringIncludes(retried, "LATEST_TAIL");
    assert(!retried.includes("OLD_0"));
    assertEquals(saved.sourceStartMessageId, "message:old:0");
    assert(saved.sourceEndMessageId !== "message:latest");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("forced consolidation advances full bounded ranges across a large backlog", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("Continue after compaction."),
    {
      inputLimit: 180_000,
      memoryConfig: {
        triggerEstimatedTokens: 999_999,
        retainRecentEstimatedTokens: 8_000,
      },
    },
  );
  try {
    await setupThread(run);
    for (let index = 0; index < 100; index++) {
      await createHumanMessage(run, {
        id: `message:batch:${index}`,
        text: `BATCH_${index} ${"history ".repeat(1_600)}`,
      });
    }
    await createHumanMessage(run, {
      id: "message:batch:tail",
      text: "ACTUAL_HISTORY_TAIL must remain outside both maintenance prompts.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run)).filter((item: { status: string }) =>
          item.status === "ready"
        ).length >= 2,
    );
    const ready = (await checkpoints(run)).filter((item: { status: string }) =>
      item.status === "ready"
    ).sort((left: { sequence: number }, right: { sequence: number }) =>
      left.sequence - right.sequence
    );
    const [first, second] = ready;
    assert(first && second);
    assertEquals(
      second.sourceStartMessageId,
      `message:batch:${
        Number(String(first.sourceEndMessageId).split(":").at(-1)) + 1
      }`,
    );
    assert(
      (first.metadata as { estimatedTokens: number }).estimatedTokens > 50_000,
    );
    assert(
      (first.metadata as { estimatedTokens: number }).estimatedTokens <= 60_000,
    );
    assert(
      (second.metadata as { estimatedTokens: number }).estimatedTokens > 50_000,
    );
    assert(
      (second.metadata as { estimatedTokens: number }).estimatedTokens <=
        60_000,
    );
    assert(first.sourceEndMessageId !== "message:batch:tail");
    assert(second.sourceEndMessageId !== "message:batch:tail");
    const maintenance = run.inputs.filter((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenance.length >= 2);
    assertEquals(
      maintenance.slice(0, 2).some((input) =>
        text(input).includes("ACTUAL_HISTORY_TAIL")
      ),
      false,
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a later oversized source leaves a safe checkpoint prefix", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("Continue after compaction."),
    {
      inputLimit: 30_000,
      memoryConfig: { triggerEstimatedTokens: 30_000 },
    },
  );
  try {
    await setupThread(run);
    await createHumanMessage(run, {
      id: "message:prefix",
      text: "SAFE_PREFIX " + "history ".repeat(500),
    });
    await createHumanMessage(run, {
      id: "message:oversized",
      text: "OVERSIZED_SOURCE " + "content ".repeat(40_000),
    });
    await createHumanMessage(run, {
      id: "message:oversized:tail",
      text: "Trigger forced compaction.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const saved = await checkpoint(run);
    assertEquals(saved.sourceStartMessageId, "message:prefix");
    assertEquals(saved.sourceEndMessageId, "message:prefix");
    const maintenance = run.inputs.find((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assert(maintenance);
    assertStringIncludes(text(maintenance), "SAFE_PREFIX");
    assertEquals(text(maintenance).includes("OVERSIZED_SOURCE"), false);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a source mutation during maintenance prevents a checkpoint from becoming ready", async () => {
  let mutateSource = async () => {};
  const run = await fixture(async (input) => {
    if (text(input).includes("Internal memory maintenance")) {
      await mutateSource();
      return tool(memoryProposal());
    }
    return stop("Initial answer before maintenance.");
  });
  try {
    await startUserTurn(run);
    mutateSource = async () => {
      await collection(run, "message").update({
        id: "message:user",
        set: { metadata: { changedDuringMaintenance: true } },
      }, { namespace: NAMESPACE });
    };
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "failed",
    );
    const saved = await checkpoint(run);
    assertEquals(saved.status, "failed");
    assert(saved.error);
    assertEquals(run.inputs.length, 2);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("invalid and omitted consolidation calls repair through ordinary Core continuations", async () => {
  const run = await fixture((_input, call) => {
    if (call === 1) return stop("Initial answer.");
    if (call === 2) {
      return tool({
        outcome: "changes",
        continuity: "The user still expects a normal answer about Compass.",
      }); // Invalid: no draft.
    }
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
    assertEquals(saved.error, {
      name: "Error",
      message: "fixture provider unavailable",
    });
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

Deno.test("invalid on-demand consolidation settles its own checkpoint as failed", async () => {
  const run = await fixture(
    (_input, call) =>
      call === 1
        ? tool({
          outcome: "changes",
          continuity:
            "The requested work continues, but this evidence is invalid.",
          entities: [{
            localId: "unauthorized",
            kind: "entity.project",
            summary: "This draft cites evidence outside the checkpoint.",
            name: "Unauthorized",
            sources: [{ type: "message", id: "message-not-authorized" }],
          }],
        })
        : stop("Continue normally."),
    { enabled: false },
  );
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "failed",
    );
    const saved = await checkpoint(run);
    assertEquals(saved.status, "failed");
    assert(saved.error);
    assertEquals(
      await collection(run, "memory_record").list({ limit: 10 }),
      [],
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("invalidate_memory retracts editorially without changing lifecycle", async () => {
  const run = await fixture(() => stop("No routing needed."), {
    enabled: false,
  });
  try {
    await startUserTurn(run);
    const spaces = collection(run, "memory_space");
    const grants = collection(run, "memory_space_access");
    const checkpoints = collection(run, "long_term_memory");
    const records = collection(run, "memory_record");
    await spaces.create({
      id: "space-a",
      name: "Space A",
      scopeType: "thread",
      scopeId: "thread-a",
      threadId: "thread-a",
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await grants.create({
      id: "grant-a",
      threadId: "thread-a",
      memorySpaceId: "space-a",
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await checkpoints.create({
      id: "checkpoint-a",
      threadId: "thread-a",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "ready",
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
      metadata: {},
    });
    await records.create({
      id: "occurrence-a",
      memorySpaceId: "space-a",
      consolidationId: "checkpoint-a",
      createdByAgentId: "north",
      originThreadId: "thread-a",
      form: "occurrence",
      kind: "occurrence.event",
      summary: "The original event happened.",
      status: "happened",
      validity: {
        status: "valid",
        sources: Array.from({ length: 55 }, (_, index) => ({
          type: "message",
          id: `validity-source-${index}`,
        })),
      },
      content: [],
      temporal: { recordedAt: "2026-08-31T00:00:00.000Z" },
      epistemic: { basis: "observed", stance: "affirmed" },
      provenance: {
        sources: Array.from({ length: 55 }, (_, index) => ({
          type: "message",
          id: `provenance-source-${index}`,
        })),
        recordedBy: { type: "agent", id: "north" },
        consolidationId: "internal-checkpoint-token",
      },
      data: { publicField: "public-value" },
      embedding: [0.123456789, 0.987654321],
      metadata: { storageSecret: "internal-metadata-token" },
    });
    for (let index = 0; index < 51; index++) {
      await records.create({
        id: `occurrence-related-${index}`,
        memorySpaceId: "space-a",
        consolidationId: "checkpoint-a",
        createdByAgentId: "north",
        originThreadId: "internal-origin-thread-token",
        form: "occurrence",
        kind: "occurrence.event",
        summary: `Related accessible event ${index}.`,
        status: "happened",
        validity: { status: "valid" },
        content: [],
        temporal: { recordedAt: "2026-08-31T00:00:00.000Z" },
        epistemic: null,
        provenance: {
          sources: [],
          recordedBy: { type: "agent", id: "north" },
          consolidationId: "checkpoint-a",
        },
        data: {},
        embedding: null,
        metadata: {},
      });
    }
    await spaces.create({
      id: "space-other",
      name: "Other Space",
      scopeType: "global",
      scopeId: "other-scope",
      threadId: null,
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await records.create({
      id: "occurrence-other-space",
      memorySpaceId: "space-other",
      consolidationId: "checkpoint-a",
      createdByAgentId: "north",
      originThreadId: "thread-a",
      form: "occurrence",
      kind: "occurrence.event",
      summary: "An inaccessible event.",
      status: "happened",
      validity: { status: "valid" },
      content: [],
      temporal: { recordedAt: "2026-08-31T00:00:00.000Z" },
      epistemic: null,
      provenance: { sources: [], recordedBy: { type: "agent", id: "north" } },
      data: {},
      embedding: null,
      metadata: {},
    });
    for (let index = 0; index < 51; index++) {
      await run.engine.collections.transaction({
        operationKey: `memory-public-relation-${index}`,
        namespace: NAMESPACE,
        execute: ({ relations }) =>
          relations.upsert({
            id: `memory-public-relation-${index}`,
            type: "supports",
            source: { type: "memory_record", id: "occurrence-a" },
            target: {
              type: "memory_record",
              id: `occurrence-related-${index}`,
            },
            metadata: { storageSecret: "internal-relation-token" },
          }),
      });
    }
    await run.engine.collections.transaction({
      operationKey: "memory-inaccessible-relation",
      namespace: NAMESPACE,
      execute: ({ relations }) =>
        relations.upsert({
          id: "memory-inaccessible-relation",
          type: "supports",
          source: { type: "memory_record", id: "occurrence-a" },
          target: { type: "memory_record", id: "occurrence-other-space" },
          metadata: { storageSecret: "internal-cross-space-token" },
        }),
    });
    const context = createTestDomainContext(run.engine, NAMESPACE, {
      now: () => new Date("2026-08-31T01:00:00.000Z"),
    });
    const metadata = {
      schema: "copilotz.core.tool-action.v1",
      planId: "invalidate-plan",
      planMessageId: "message:user",
      planIndex: 0,
      stageIndex: 0,
      stageCount: 1,
      planSize: 1,
      toolCallId: "invalidate-call",
      action: "invalidate_memory",
      threadId: "thread-a",
      triggerMessageId: "message:user",
      agentId: "north",
      agentParticipantId: "agent-north",
      initiatorParticipantId: "human-a",
      availableToolIds: [
        "invalidate_memory",
        "search_memory",
        "inspect_memory",
      ],
      responseVisibility: { kind: "public" },
      parentLlmActionRunId: "invalidate-llm",
    };
    const result = await context.actions.invalidate_memory({
      id: "occurrence-a",
      disposition: "retracted",
      reason: "The source was incorrect.",
    }, { operationKey: "invalidate-once", metadata });
    const invalidated = result as {
      memory: {
        status: string;
        validity: { status: string; sources: unknown };
      };
    };
    assertEquals(invalidated.memory.status, "happened");
    assertEquals(invalidated.memory.validity.status, "retracted");
    assertEquals(invalidated.memory.validity.sources, [{
      type: "message",
      id: "message:user",
    }]);
    const saved = await records.get({ id: "occurrence-a" });
    assertEquals(saved?.status, "happened");
    assertEquals((saved?.validity as { status: string }).status, "retracted");
    const normal = await context.actions.search_memory({
      form: "occurrence",
      limit: 1,
    }, {
      operationKey: "search-normal",
      metadata: { ...metadata, action: "search_memory" },
    });
    const historical = await context.actions.search_memory({
      form: "occurrence",
      includeHistory: true,
      limit: 100,
    }, {
      operationKey: "search-history",
      metadata: { ...metadata, action: "search_memory" },
    });
    const normalOutput = normal as {
      memories: Array<{ id: string }>;
      scanned: number;
      matched: number;
      returned: number;
      truncated: boolean;
    };
    const historicalOutput = historical as typeof normalOutput;
    assertEquals(normalOutput.scanned, 52);
    assertEquals(normalOutput.matched, 51);
    assertEquals(normalOutput.returned, 1);
    assertEquals(normalOutput.truncated, true);
    assertEquals(
      normalOutput.memories.some((item) => item.id === "occurrence-a"),
      false,
    );
    assertEquals(historicalOutput.scanned, 52);
    assertEquals(historicalOutput.matched, 52);
    assertEquals(historicalOutput.returned, 52);
    assertEquals(historicalOutput.truncated, false);
    assertEquals(
      historicalOutput.memories.some((item) =>
        item.id === "occurrence-other-space"
      ),
      false,
    );
    const inspected = await context.actions.inspect_memory({
      id: "occurrence-a",
    }, {
      operationKey: "inspect-retracted",
      metadata: { ...metadata, action: "inspect_memory" },
    });
    const inspectedOutput = inspected as {
      memory: {
        validity: {
          status: string;
          sources: {
            items: Array<{ type: string; id: string }>;
            total: number;
            returned: number;
            truncated: boolean;
          };
        };
        provenance: {
          sources: {
            items: Array<{ type: string; id: string }>;
            total: number;
            returned: number;
            truncated: boolean;
          };
        };
      };
      relations: {
        items: Array<{ other: { id: string } }>;
        scanned: number;
        matched: number;
        returned: number;
        truncated: boolean;
      };
    };
    assertEquals(inspectedOutput.memory.validity.status, "retracted");
    assertEquals(inspectedOutput.memory.provenance.sources, {
      items: Array.from({ length: 50 }, (_, index) => ({
        type: "message",
        id: `provenance-source-${index}`,
      })),
      total: 55,
      returned: 50,
      truncated: true,
    });
    assertEquals(
      inspectedOutput.relations.scanned > inspectedOutput.relations.matched,
      true,
    );
    assertEquals(inspectedOutput.relations.matched, 51);
    assertEquals(inspectedOutput.relations.returned, 50);
    assertEquals(inspectedOutput.relations.truncated, true);
    assertEquals(
      inspectedOutput.relations.items.some((relation) =>
        relation.other.id === "occurrence-other-space"
      ),
      false,
    );
    const serializedSearch = JSON.stringify(historical);
    const serializedInspect = JSON.stringify(inspected);
    for (
      const forbidden of [
        "embedding",
        "namespace",
        "memorySpaceId",
        "originThreadId",
        "consolidationId",
        "createdByAgentId",
        "metadata",
        "internal-checkpoint-token",
        "internal-origin-thread-token",
        "internal-metadata-token",
        "internal-relation-token",
        "internal-cross-space-token",
        "0.123456789",
      ]
    ) {
      assertEquals(serializedSearch.includes(forbidden), false, forbidden);
      assertEquals(serializedInspect.includes(forbidden), false, forbidden);
    }
    const searchValidate = new AjvModule.default({
      allErrors: true,
      strict: false,
    }).compile(searchMemoryAction.outputSchema as any);
    const inspectValidate = new AjvModule.default({
      allErrors: true,
      strict: false,
    }).compile(inspectMemoryAction.outputSchema as any);
    assert(searchValidate(normal), JSON.stringify(searchValidate.errors));
    assert(searchValidate(historical), JSON.stringify(searchValidate.errors));
    assert(inspectValidate(inspected), JSON.stringify(inspectValidate.errors));

    // An identical retry is idempotent: it preserves the original validity
    // payload (including changedAt) rather than producing a new write.
    const retry = await context.actions.invalidate_memory({
      id: "occurrence-a",
      disposition: "retracted",
      reason: "The source was incorrect.",
    }, { operationKey: "invalidate-retry", metadata });
    assertEquals(
      (retry as { memory: { validity: unknown } }).memory.validity,
      (invalidated as { memory: { validity: unknown } }).memory.validity,
    );
    await assertRejects(
      () =>
        context.actions.invalidate_memory({
          id: "occurrence-a",
          disposition: "archived",
          reason: "A conflicting disposition.",
        }, { operationKey: "invalidate-conflict", metadata }),
      Error,
      "different editorial disposition",
    );

    // A record outside the thread's read-write spaces cannot be altered.
    // The space exists to satisfy the collection relation, but no access
    // grant connects it to thread-a.
    await assertRejects(
      () =>
        context.actions.invalidate_memory({
          id: "occurrence-other-space",
          disposition: "retracted",
          reason: "No authority over this record.",
        }, { operationKey: "invalidate-unauthorized", metadata }),
      Error,
      "not writable from this thread",
    );
  } finally {
    await run.close();
  }
});

Deno.test("consolidation cannot change the lifecycle of a readable Space peer", async () => {
  const run = await fixture(() => stop("No routing needed."), {
    enabled: false,
  });
  try {
    await startUserTurn(run);
    const context = createTestDomainContext(run.engine, NAMESPACE);
    const c = context.collections;
    await c.thread.create({ id: "peer-thread" });
    await context.actions.spaces({
      operation: "create",
      spaceId: "shared",
      ownerId: "human-a",
    });
    for (const recordId of ["thread-a", "peer-thread"]) {
      await context.actions.spaces({
        operation: "attach",
        spaceId: "shared",
        collection: "thread",
        recordId,
      });
    }
    await c.memorySpace.create({
      id: "memory-space:thread:peer-thread",
      scopeType: "thread",
      scopeId: "peer-thread",
      threadId: "peer-thread",
    });
    await c.longTermMemory.create({
      id: "peer-checkpoint",
      threadId: "peer-thread",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "ready",
      sequence: 1,
      agentId: "other-agent",
      sourceStartMessageId: "peer-message",
      sourceEndMessageId: "peer-message",
    });
    const peer = await c.memoryRecord.create({
      id: "peer-record",
      memorySpaceId: "memory-space:thread:peer-thread",
      consolidationId: "peer-checkpoint",
      createdByAgentId: "other-agent",
      originThreadId: "peer-thread",
      form: "assertion",
      kind: "assertion.state",
      summary: "Peer owns this fact",
      status: "current",
      validity: { status: "valid" },
      temporal: {},
      provenance: {},
      data: {},
    });
    await assertRejects(
      () =>
        context.actions.consolidate_memory({
          outcome: "changes",
          continuity: "Keep the peer's fact intact.",
          lifecycle: [{
            target: { memoryId: "peer-record" },
            status: "retracted",
            sources: [{ type: "message", id: "message:user" }],
          }],
        }, {
          metadata: {
            schema: "copilotz.core.tool-action.v1",
            planId: "peer-write-plan",
            planMessageId: "message:user",
            planIndex: 0,
            stageIndex: 0,
            stageCount: 1,
            planSize: 1,
            toolCallId: "peer-write-call",
            action: "consolidate_memory",
            threadId: "thread-a",
            triggerMessageId: "message:user",
            agentId: "north",
            agentParticipantId: "agent-north",
            initiatorParticipantId: "human-a",
            availableToolIds: ["consolidate_memory"],
            responseVisibility: { kind: "public" },
            parentLlmActionRunId: "peer-write-llm",
          },
        }),
      Error,
      "read-only peer",
    );
    assertEquals(await c.memoryRecord.get({ id: "peer-record" }), peer);
  } finally {
    await run.close();
  }
});
