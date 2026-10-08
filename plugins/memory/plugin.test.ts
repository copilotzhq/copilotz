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
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import {
  createSqlSession,
  type SqlExecutor,
  type SqlSession,
} from "../../runtime/events/index.ts";
import { prepareBuiltinModelTranscript } from "../llm/adapters/builtin/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { projectMessages } from "../core/shared/testing/projections.ts";
import { createTestDomainContext } from "../core/shared/testing/context.ts";
import AjvModule from "ajv";
import { consolidateMemoryAction } from "./actions/consolidate-memory/index.ts";
import { inspectMemoryAction } from "./actions/inspect-memory/index.ts";
import { searchMemoryAction } from "./actions/search-memory/index.ts";
import { toolSourceHandle } from "./shared/evidence.ts";
import { memoryPlugin } from "./plugin.ts";
import { builtInToolsPlugin } from "@copilotz/copilotz/tools/builtin";
import type { LongTermMemoryConfig } from "./resources/memory/config/index.ts";
import { provisionVectorStorage } from "@copilotz/copilotz/persistence";

const NAMESPACE = "tenant-memory-native-turn";
const SCHEMA = "copilotz_memory_native_turn";

type Script = (input: LlmAdapterCallInput, index: number) =>
  | LlmAdapterResult
  | Promise<LlmAdapterResult>;

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  inputs: readonly LlmAdapterCallInput[];
  setMemoryConfig(config: Partial<LongTermMemoryConfig>): void;
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

function memoryProposal(sources?: string[]) {
  return {
    continuity: "Compass remains the active project for the next turn.",
    remember: [{
      text: "Compass is the active project.",
      ...(sources ? { sources } : {}),
    }],
  };
}

function text(input: LlmAdapterCallInput): string {
  return input.request.messages.flatMap((message) =>
    message.content.map((part) => part.type === "text" ? part.text : "")
  ).join("\n");
}

function recording(
  base: SqlSession,
  statements: { sql: string; params?: unknown[] }[],
): SqlSession {
  const recorded = (executor: SqlExecutor): SqlExecutor => ({
    query: <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      statements.push({ sql, params });
      return executor.query<T>(sql, params);
    },
  });
  return {
    ...recorded(base),
    transaction: (operation) =>
      base.transaction((tx) => operation(recorded(tx))),
    ...(base.readSnapshot
      ? {
        readSnapshot: <T>(operation: (executor: SqlExecutor) => Promise<T>) =>
          base.readSnapshot!((snapshot) => operation(recorded(snapshot))),
      }
      : {}),
  };
}

async function fixture(
  script: Script,
  options: Readonly<{
    enabled?: boolean;
    inputLimit?: number;
    fallbackInputLimit?: number;
    outputLimit?: number;
    contextText?: string;
    memoryConfig?: Partial<LongTermMemoryConfig>;
    vectors?: boolean;
    statements?: { sql: string; params?: unknown[] }[];
    dynamicInstructions?: boolean;
    tools?: readonly string[];
  }> = {},
): Promise<Fixture> {
  const db = await createTestDatabase({
    url: ":memory:",
    ...(options.vectors ? { pgliteExtensions: ["vector"] } : {}),
  });
  const inputs: LlmAdapterCallInput[] = [];
  const mutableMemoryConfig: Record<string, unknown> = {
    enabled: options.enabled,
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 0,
    ...options.memoryConfig,
  };
  const memory = memoryPlugin;
  const app = definePlugin({
    id: "test.memory-native-agent-turn",
    version: "1.0.0",
    resources: {
      memory: {
        ...(options.vectors
          ? {
            embeddingProfile: {
              model: "fixture",
              revision: "1",
              dimensions: 2,
              metric: "cosine" as const,
            },
          }
          : {}),
        config: mutableMemoryConfig,
      },
      agents: {
        north: defineAgent({
          id: "north",
          name: "North",
          role: "assistant",
          instructions: "NORTH_NATIVE_MEMORY_INSTRUCTIONS",
          ...(options.dynamicInstructions
            ? {
              dynamicResolve: (facts) => ({
                instructions:
                  `NORTH_NATIVE_MEMORY_INSTRUCTIONS trigger=${facts.triggerMessage.id}`,
              }),
            }
            : {}),
          models: {
            generate: [
              {
                connection: "test_model",
                model: "native-memory-model",
                ...(options.inputLimit === undefined &&
                    options.outputLimit === undefined
                  ? {}
                  : {
                    options: {
                      ...(options.inputLimit === undefined
                        ? {}
                        : { limitEstimatedInputTokens: options.inputLimit }),
                      ...(options.outputLimit === undefined
                        ? {}
                        : { maxTokens: options.outputLimit }),
                    },
                  }),
              },
              ...(options.fallbackInputLimit === undefined ? [] : [{
                connection: "test_model",
                model: "fallback-memory-model",
                options: {
                  limitEstimatedInputTokens: options.fallbackInputLimit,
                  ...(options.outputLimit === undefined
                    ? {}
                    : { maxTokens: options.outputLimit }),
                },
              }]),
            ],
          },
          capabilities: { tools: options.tools ?? ["consolidate_memory"] },
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
            content: options.contextText ?? "NATIVE_MEMORY_CONTEXT",
          }),
        }),
      },
    },
    adapters: {
      llm: { test: adapter(script, inputs) },
      memoryEmbedding: options.vectors
        ? {
          default: (texts: readonly string[]) =>
            Promise.resolve(texts.map(() => [1, 0])),
        }
        : {},
    },
  });
  const registry = await createPluginRegistry({
    plugins: [memory, ...(options.tools ? [builtInToolsPlugin] : []), app],
  });
  const engine = await createCopilotzEngine({
    session: options.statements
      ? recording(createSqlSession(db), options.statements)
      : createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
  });
  if (options.vectors) await provisionVectorStorage(db, SCHEMA);
  return Object.freeze({
    db,
    engine,
    inputs,
    setMemoryConfig(config) {
      Object.assign(mutableMemoryConfig, config);
    },
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
    {
      id: string;
      text: string;
      recipientIds?: readonly string[];
      metadata?: Readonly<Record<string, unknown>>;
    }
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
    metadata: input.metadata ?? {},
  }, {
    namespace: NAMESPACE,
    metadata: {
      core: {
        threadId: "thread-a",
        routing: {
          senderId: "human-a",
          recipientIds: input.recipientIds ?? [],
        },
      },
    },
    identity: { deduplicationId: `${input.id}:create` },
  });
  return created.id;
}

async function createKanbanToolResult(fixture: Fixture, text: string) {
  const participants = collection(fixture, "participant");
  await participants.create({
    id: "kanban-tool",
    externalId: "kanban",
    participantType: "tool",
    name: "Kanban",
  }, { namespace: NAMESPACE });
  const threads = collection(fixture, "thread");
  await threads.update({
    id: "thread-a",
    set: { participantIds: ["human-a", "agent-north", "kanban-tool"] },
  }, { namespace: NAMESPACE });
  const content = await fixture.engine.content.preparer.prepare(text, {
    namespace: NAMESPACE,
    idempotencyKey: "message:kanban:result:content",
  });
  return await collection(fixture, "message").create({
    id: "message:kanban:result",
    threadId: "thread-a",
    senderId: "kanban-tool",
    recipientIds: [],
    content,
    metadata: {
      requesterId: "agent-north",
      historyVisibility: "public",
      toolInvocation: { id: "kanban:result" },
    },
  }, {
    namespace: NAMESPACE,
    metadata: {
      core: {
        threadId: "thread-a",
        routing: { senderId: "kanban-tool", recipientIds: [] },
      },
    },
    identity: { deduplicationId: "message:kanban:result:create" },
  });
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
  condition: () => boolean | Promise<boolean>,
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
    `Memory native turn did not settle: ${
      JSON.stringify({
        deadLetters,
        checkpoints: (await checkpoints(fixture)).map((
          item: {
            id: string;
            status: string;
            error: unknown;
            metadata: unknown;
          },
        ) => ({
          id: item.id,
          status: item.status,
          error: item.error,
          metadata: item.metadata,
        })),
      })
    }`,
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
    consolidateMemoryAction.outputSchema!,
  );
  assert(validate(value), JSON.stringify(validate.errors));
}

Deno.test("memory composes Core-native dispatch and settlement without a model selector", () => {
  const plugin = memoryPlugin;
  assertEquals(plugin.plugins, [corePlugin]);
  assertEquals(Object.keys(plugin.actions).sort(), [
    "consolidate_memory",
    "inspect_memory",
    "list_knowledge_spaces",
    "search_memory",
  ]);
  assertEquals(Object.keys(plugin.processors).sort(), [
    "dispatchConsolidation",
    "settleConsolidation",
  ]);
});

Deno.test("checkpoint dispatch is a hidden ordinary Agent turn that atomically commits trusted memory", async () => {
  const run = await fixture((_input, call) =>
    call === 1
      ? stop("I will remember that.")
      : tool(memoryProposal(["message:message:user"]))
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
    assertStringIncludes(
      maintenance.request.instructions ?? "",
      "NATIVE_MEMORY_CONTEXT",
    );
    // The maintenance turn receives exactly the reserved source range, rather
    // than the ordinary public reply that follows the triggering message.
    assertStringIncludes(
      maintenanceText,
      "Remember Compass and answer normally.",
    );
    // The source uses the identical normal preparation, followed by maintenance.
    assertEquals(
      maintenance.request.instructions,
      run.inputs[0]!.request.instructions,
    );
    assertEquals(maintenance.request.tools, run.inputs[0]!.request.tools);
    assertEquals(
      maintenance.request.messages[0],
      run.inputs[0]!.request.messages[0],
    );
    assertEquals(maintenance.request.messages.at(-1)?.role, "user");
    assertEquals(maintenance.request.tools?.map((value) => value.name), [
      "consolidate_memory",
      "readToolResult",
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
    const records = await collection(run, "memory_note").list({
      limit: 10,
    });
    assertEquals(records.length, 1);
    const sources = records[0]!.sources as readonly {
      type: string;
      id: string;
    }[];
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
      ["message:user"],
    );
    assertEquals(sources.filter((source) => source.type === "asset").length, 0);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a no_changes maintenance Action completes with schema-valid continuity", async () => {
  const run = await fixture((_input, call) =>
    call === 1 ? stop("I will remember that.") : tool({
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
    const source = maintenance.request.messages.find((message) =>
      message.role === "assistant"
    );
    assert(source?.role === "assistant");
    assertEquals(source.toolCalls?.[0]?.id, "ask-south");
    assertEquals(source.toolPlanId, "unresolved-plan");
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

for (const fallbackInputLimit of [undefined, 120_000]) {
  Deno.test(`an oversized preferred model compacts before replying${fallbackInputLimit ? " even when a fallback fits" : ""}`, async () => {
    const run = await fixture(
      (input) =>
        text(input).includes("Internal memory maintenance")
          ? tool(memoryProposal())
          : stop("The compacted normal request can continue."),
      {
        inputLimit: 40_000,
        fallbackInputLimit,
        memoryConfig: { triggerEstimatedTokens: 999_999 },
      },
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
      assertEquals(retriedInput.model, "native-memory-model");
      assertEquals(
        run.inputs.some((input) => input.model === "fallback-memory-model"),
        false,
      );
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
}

Deno.test("a smaller fallback does not force compaction when the preferred model fits", async () => {
  const run = await fixture(
    () => stop("The preferred model can accept the ordinary history."),
    {
      inputLimit: 180_000,
      fallbackInputLimit: 40_000,
      memoryConfig: { triggerEstimatedTokens: 999_999 },
    },
  );
  try {
    await setupThread(run);
    for (let index = 0; index < 8; index++) {
      await createHumanMessage(run, {
        id: `message:large:${index}`,
        text: `LARGE_${index} ${"history ".repeat(6_400)}`,
      });
    }
    await createHumanMessage(run, {
      id: "message:preferred-fits",
      text: "Keep the full history when it fits the preferred model.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await projectMessages(run.engine, NAMESPACE, "thread-a")).some((
          message,
        ) => message.sender.id === "agent-north"),
    );
    assertEquals(run.inputs.map((input) => input.model), [
      "native-memory-model",
    ]);
    assertStringIncludes(text(run.inputs[0]!), "LARGE_0");
    assertStringIncludes(text(run.inputs[0]!), "LARGE_7");
    assertEquals(await checkpoints(run), []);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("a fitting preferred model still falls back after a provider failure without compaction", async () => {
  const run = await fixture(
    (input) => {
      if (input.model === "native-memory-model") {
        throw new Error("Provider unavailable");
      }
      return stop("The fallback can answer after a provider failure.");
    },
    {
      inputLimit: 180_000,
      fallbackInputLimit: 120_000,
      memoryConfig: { triggerEstimatedTokens: 999_999 },
    },
  );
  try {
    await setupThread(run);
    await createHumanMessage(run, {
      id: "message:provider-failure",
      text:
        "Continue using the configured fallback if the provider is unavailable.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await projectMessages(run.engine, NAMESPACE, "thread-a")).some((
          message,
        ) => message.sender.id === "agent-north"),
    );
    assertEquals(run.inputs.map((input) => input.model), [
      "native-memory-model",
      "fallback-memory-model",
    ]);
    assertEquals(await checkpoints(run), []);
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
    for (let index = 0; index < 180; index++) {
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
      (second.metadata as { estimatedTokens: number }).estimatedTokens > 50_000,
    );
    for (const saved of [first, second]) {
      const budget = saved.metadata as {
        estimatedTokens: number;
        instructionEstimatedTokens: number;
        historyLimitEstimatedTokens: number;
      };
      assert(
        budget.estimatedTokens + budget.instructionEstimatedTokens <=
          budget.historyLimitEstimatedTokens,
      );
    }
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

Deno.test("bounded post-boundary Tool history lets the next turn continue", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("The post-compaction user request can continue."),
    {
      inputLimit: 180_000,
      memoryConfig: {
        triggerEstimatedTokens: 1,
        retainRecentEstimatedTokens: 0,
      },
    },
  );
  try {
    await startUserTurn(run, "message:boundary");
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const boundary = (await checkpoints(run)).find(
      (item: { status: string }) => item.status === "ready",
    );
    assert(boundary);

    // Prevent background threshold-based reservation so the oversized user
    // turn exercises the forced foreground compaction hook below.
    run.setMemoryConfig({
      triggerEstimatedTokens: 999_999,
      retainRecentEstimatedTokens: 8_000,
    });

    const json =
      '{"card":"KBN-428","status":"active","summary":"review persistence behavior"}, ';
    const prose =
      "Kanban card KBN-428 is active and must be reviewed before release. ";
    const pattern = json.repeat(2) + prose.repeat(7);
    const kanbanResult = pattern.repeat(Math.ceil(241_125 / pattern.length))
      .slice(0, 241_125);
    assertEquals(new TextEncoder().encode(kanbanResult).byteLength, 241_125);
    const kanbanTokens = estimateTextTokens(kanbanResult);
    assert(kanbanTokens > 65_000 && kanbanTokens < 66_000);
    await createKanbanToolResult(run, kanbanResult);

    for (let index = 0; index < 3; index++) {
      await createHumanMessage(run, {
        id: `message:post-boundary:${index}`,
        text: `POST_BOUNDARY_${index} ${"界".repeat(40_000)}`,
      });
    }
    await createHumanMessage(run, {
      id: "message:current-request",
      text: "CURRENT_USER_REPLY continue the active Kanban task.",
      recipientIds: ["agent-north"],
    });

    await eventually(
      run,
      () =>
        run.inputs.some((input) => text(input).includes("CURRENT_USER_REPLY")),
    );
    assertEquals(
      (await checkpoints(run)).filter((item: { status: string }) =>
        item.status === "ready"
      ).length,
      1,
    );
    const reply = run.inputs.find((input) =>
      text(input).includes("CURRENT_USER_REPLY")
    );
    assert(reply);
    assert(!text(reply).includes("KBN-428"));
    assertStringIncludes(text(reply), "message:kanban:result");
    assertStringIncludes(text(reply), "readToolResult");
    assertStringIncludes(text(reply), "POST_BOUNDARY_0");
    assertStringIncludes(text(reply), "POST_BOUNDARY_1");
    assertStringIncludes(text(reply), "POST_BOUNDARY_2");
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
        continuity: "The user still expects a normal answer about Compass.",
        remember: [{ text: "" }],
      }); // Invalid: an empty note.
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

Deno.test("consolidation can use another granted Tool before completing its checkpoint", async () => {
  const run = await fixture((input, call) => {
    if (call === 1) return stop("Initial answer.");
    if (call === 2) {
      assert(
        input.request.tools?.some((tool) => tool.name === "get_current_time"),
      );
      return {
        ...tool({}),
        toolCalls: [{ id: "read-time", action: "get_current_time", input: {} }],
      };
    }
    assertEquals(call, 3);
    const result = input.request.messages.find((message) =>
      message.role === "tool"
    );
    assert(result?.role === "tool" && result.toolPlanId);
    return tool(
      memoryProposal([toolSourceHandle(result.toolPlanId, result.toolCallId)]),
    );
  }, { tools: ["get_current_time", "consolidate_memory"] });
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    assertEquals((await checkpoints(run)).length, 1);
    assertEquals(run.inputs.length, 3);
    const notes = await collection(run, "memory_note").list({});
    assertEquals(notes[0].sources.length, 1);
    const source = await collection(run, "message").get({
      id: notes[0].sources[0].id,
    });
    assertEquals(source.metadata.toolStatus, "completed");
    assertEquals(source.historyScopeId, (await checkpoints(run))[0].id);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("an unknown consolidation Tool returns feedback and settles the same checkpoint", async () => {
  const run = await fixture((input, call) => {
    if (call === 1) return stop("Initial answer.");
    if (call === 2) {
      return {
        ...tool(memoryProposal()),
        toolCalls: [{
          id: "misspelled-consolidation",
          action: "consolid_memory",
          input: memoryProposal(),
        }],
      };
    }
    assertEquals(call, 3);
    assert(input.request.messages.some((message) => message.role === "tool"));
    const feedback = JSON.stringify(
      input.request.messages.filter((message) => message.role === "tool"),
    );
    assertStringIncludes(feedback, "ToolUnavailable");
    assertStringIncludes(feedback, "consolid_memory");
    return tool(memoryProposal());
  });
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    assertEquals((await checkpoints(run)).length, 1);
    assertEquals(run.inputs.length, 3);
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("consolidation budgets the full prefix and a large Tool repair continuation", async () => {
  const run = await fixture((input) => {
    if (!text(input).includes("Internal memory maintenance")) {
      return stop("The ordinary reply proceeds.");
    }
    if (
      !JSON.stringify(input.request.messages).includes("CONTINUATION_BUDGET")
    ) {
      return {
        ...tool(memoryProposal()),
        toolCalls: [{
          id: "large-misspelled-consolidation",
          action: "consolid_memory",
          input: {
            ...memoryProposal(),
            continuity: "CONTINUATION_BUDGET " + "durable ".repeat(4_000),
          },
        }],
      };
    }
    assertStringIncludes(
      JSON.stringify(input.request.messages),
      "ToolUnavailable",
    );
    return tool(memoryProposal());
  }, {
    inputLimit: 60_000,
    outputLimit: 10_000,
    contextText: "NATIVE_MEMORY_CONTEXT " + "background ".repeat(3_000),
    memoryConfig: { triggerEstimatedTokens: 20_000 },
  });
  try {
    await setupThread(run);
    for (let index = 0; index < 10; index++) {
      await createHumanMessage(run, {
        id: `message:continuation-budget:${index}`,
        text: `SOURCE_${index} ` + "history ".repeat(1_600),
      });
    }
    assertEquals(
      (await checkpoints(run)).length,
      0,
      "message creation alone must not reserve an unbudgeted checkpoint",
    );
    await createHumanMessage(run, {
      id: "message:continuation-budget:latest",
      text: "Continue the ordinary task.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const maintenance = run.inputs.filter((input) =>
      text(input).includes("Internal memory maintenance")
    );
    assertEquals(maintenance.length, 2);
    for (const [index, input] of maintenance.entries()) {
      const prepared = await prepareBuiltinModelTranscript(
        {
          provider: "openai",
          model: input.model,
          apiKey: "unused-test-key",
        },
        "generate",
        input.options,
        input,
      );
      assert(prepared.inputTokenEstimate.estimatedTokens <= 60_000);
      if (index === 0) {
        assert(prepared.inputTokenEstimate.estimatedTokens + 10_000 <= 60_000);
        assertStringIncludes(text(input), "SOURCE_0");
      }
    }
    const normal = run.inputs.find((input) =>
      !text(input).includes("Internal memory maintenance")
    )!;
    assertEquals(
      maintenance[0]!.request.instructions,
      normal.request.instructions,
    );
    assertEquals(maintenance[0]!.request.tools, normal.request.tools);
    assertEquals(
      maintenance[0]!.request.messages[0],
      normal.request.messages[0],
    );
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
          continuity:
            "The requested work continues, but this evidence is invalid.",
          remember: [{
            text: "This draft cites evidence outside the checkpoint.",
            sources: ["message:message-not-authorized"],
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
      await collection(run, "memory_note").list({ limit: 10 }),
      [],
    );
    await assertNoDeadLetters(run);
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
    const peer = await c.memoryNote.create({
      id: "peer-record",
      memorySpaceId: "memory-space:thread:peer-thread",
      consolidationId: "peer-checkpoint",
      createdByAgentId: "other-agent",
      originThreadId: "peer-thread",
      text: "Peer owns this fact",
      sources: [],
      retirement: null,
    });
    await assertRejects(
      () =>
        context.actions.consolidate_memory({
          continuity: "Keep the peer's fact intact.",
          retire: [{ id: "peer-record", reason: "incorrect" }],
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
      "not active in the writable scope",
    );
    assertEquals(await c.memoryNote.get({ id: "peer-record" }), peer);
  } finally {
    await run.close();
  }
});

Deno.test("Memory consolidation and public search use persisted pgvector projections", async () => {
  const run = await fixture(
    (_input, call) => call === 1 ? stop("Remembered.") : tool(memoryProposal()),
    { vectors: true },
  );
  try {
    await startUserTurn(run);
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const records = await collection(run, "memory_note").list({ limit: 100 });
    assertEquals(records.length, 1);
    assertEquals("embedding" in records[0], false);
    const persisted = await run.db.query<{ type: string; count: string }>(
      `SELECT pg_typeof(value)::text AS type, count(*)::text AS count FROM "${SCHEMA}".copilotz_vectors GROUP BY pg_typeof(value)`,
    );
    assertEquals(persisted.rows, [{ type: "vector", count: "1" }]);
    const context = createTestDomainContext(run.engine, NAMESPACE);
    const result = await context.actions.search_memory({
      query: "Compass",
      limit: 5,
    }, {
      operationKey: "vector-search",
      metadata: { threadId: "thread-a", agentId: "north" },
    }) as { notes: Array<{ id: string; similarity: number }> };
    assertEquals(result.notes.map((x) => x.id), [records[0].id]);
    assertEquals(result.notes[0].similarity, 1);
    await run.engine.collections.rebuild(NAMESPACE);
    const replayed = await context.actions.search_memory({
      query: "Compass",
      limit: 5,
    }, {
      operationKey: "vector-search-after-replay",
      metadata: { threadId: "thread-a", agentId: "north" },
    }) as typeof result;
    assertEquals(replayed.notes, result.notes);
    for (
      const grant of await context.collections.memorySpaceAccess.list({
        where: { threadId: "thread-a" },
      })
    ) {
      await context.collections.memorySpaceAccess.delete({ id: grant.id });
    }
    const revoked = await context.actions.search_memory({
      query: "Compass",
      limit: 5,
    }, {
      operationKey: "vector-search-revoked",
      metadata: { threadId: "thread-a", agentId: "north" },
    }) as typeof result;
    assertEquals(revoked.notes, []);
  } finally {
    await run.close();
  }
});

Deno.test("memory preserves typed images and the normal provider prefix with dynamic instructions", async () => {
  const run = await fixture(
    (input) =>
      text(input).includes("Internal memory maintenance")
        ? tool(memoryProposal())
        : stop("Image reviewed."),
    { inputLimit: 180_000, dynamicInstructions: true },
  );
  try {
    await startUserTurn(run, "message:prior-boundary");
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const image = new Uint8Array(122_960);
    image.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const content = await run.engine.content.preparer.prepare([
      { type: "text", text: "Remember the diagram.", role: "body" },
      {
        type: "image",
        bytes: image,
        mediaType: "image/png",
        name: "diagram.png",
        role: "body",
      },
    ], { namespace: NAMESPACE, idempotencyKey: "image-regression" });
    await collection(run, "message").create({
      id: "message:image",
      threadId: "thread-a",
      senderId: "human-a",
      recipientIds: ["agent-north"],
      content,
      metadata: {},
    }, {
      namespace: NAMESPACE,
      metadata: {
        core: {
          threadId: "thread-a",
          routing: { senderId: "human-a", recipientIds: ["agent-north"] },
        },
      },
      identity: { deduplicationId: "image-regression:create" },
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run)).filter((item: { status: string }) =>
          item.status === "ready"
        )
          .length === 2,
    );
    assertEquals(run.inputs.length, 4);
    const [ordinary, maintenance] = run.inputs.slice(2);
    const newest = (await checkpoints(run)).find((item: { sequence: number }) =>
      item.sequence === 2
    );
    assertEquals(
      newest.sourceStartMessageId,
      (await projectMessages(run.engine, NAMESPACE, "thread-a"))[1]!.id,
    );
    assertEquals(
      maintenance!.request.instructions,
      ordinary!.request.instructions,
    );
    assertEquals(maintenance!.request.tools, ordinary!.request.tools);
    assertEquals(
      maintenance!.request.messages[0],
      ordinary!.request.messages[0],
    );
    const images = maintenance!.request.messages.flatMap((message) =>
      message.content
    ).filter((part) => part.type === "image");
    assertEquals(images.length, 1);
    const preparedImage = images[0];
    assert(preparedImage?.type === "image");
    assertEquals(preparedImage.bytes, image);
    assert(
      !text(maintenance!).includes('"0":137'),
      "binary bytes are never flattened into JSON text",
    );
    const provider = {
      provider: "openai" as const,
      model: "native-memory-model",
      apiKey: "unused-test-key",
    };
    const normalWire = await prepareBuiltinModelTranscript(
      provider,
      "generate",
      {},
      ordinary!,
    );
    const memoryWire = await prepareBuiltinModelTranscript(
      provider,
      "generate",
      {},
      maintenance!,
    );
    assertEquals(
      memoryWire.messages.slice(0, normalWire.messages.length),
      normalWire.messages,
      "provider-prepared shared prefix must be identical, including images and tool definitions",
    );
    assertEquals(
      memoryWire.inputTokenEstimate.byModality.image,
      normalWire.inputTokenEstimate.byModality.image,
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("consolidation accepts a frozen source snapshot larger than the JSON predicate budget", async () => {
  const run = await fixture((_input, call) =>
    call === 1 ? stop("Remembered.") : tool(memoryProposal())
  );
  try {
    await setupThread(run);
    // Each ordinary message fits the predicate budget, but their frozen
    // history makes the private maintenance Message metadata exceed 1 MiB.
    const metadata = { trace: "x".repeat(600 * 1024) };
    await createHumanMessage(run, {
      id: "message:large-source",
      text: "Compass remains the active project.",
      metadata,
    });
    await createHumanMessage(run, {
      id: "message:large-trigger",
      text: "Remember this and answer normally.",
      recipientIds: ["agent-north"],
      metadata,
    });
    await eventually(
      run,
      async () => {
        const current = (await checkpoints(run))[0];
        return current && current.status !== "pending";
      },
    );
    const saved = await checkpoint(run);
    assertEquals(saved.status, "ready", JSON.stringify(saved.error));
    await eventually(
      run,
      async () =>
        (await collection(run, "message").list({
          where: { historyScopeId: saved.id },
          limit: 10,
        })).length >= 3,
    );
    const scoped = await collection(run, "message").list({
      where: { historyScopeId: saved.id },
      limit: 10,
    });
    assert(
      scoped.some((entry: { metadata: unknown }) =>
        JSON.stringify(entry.metadata).length > 1024 * 1024
      ),
      "the real maintenance Message must carry the oversized frozen snapshot",
    );
    const roots = scoped.filter((
      entry: { metadata: Record<string, unknown> },
    ) =>
      (entry.metadata.copilotzAgentTurn as { sourceHistory?: unknown })
        ?.sourceHistory
    );
    assertEquals(
      roots.length,
      1,
      "only the immutable root stores the full snapshot",
    );
    const continuations = scoped.filter((
      entry: { metadata: Record<string, unknown> },
    ) =>
      (entry.metadata.copilotzAgentTurn as { sourceHistoryRef?: unknown })
        ?.sourceHistoryRef
    );
    assertEquals(
      continuations.length,
      2,
      "assistant and final Tool result carry references",
    );
    assert(
      continuations.every((entry: { metadata: unknown }) =>
        JSON.stringify(entry.metadata).length < 20_000
      ),
    );
    assertEquals(run.inputs.length, 2);
    const [ordinary, maintenance] = run.inputs;
    assertEquals(
      maintenance!.request.instructions,
      ordinary!.request.instructions,
    );
    assertEquals(maintenance!.request.tools, ordinary!.request.tools);
    assertEquals(
      maintenance!.request.messages.slice(0, ordinary!.request.messages.length),
      ordinary!.request.messages,
      "the ordinary input prefix remains identical for provider caching",
    );
    assertEquals(saved.sourceStartMessageId, "message:large-source");
    const publicHistory = await projectMessages(
      run.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(saved.sourceEndMessageId, "message:large-trigger");
    assertEquals(publicHistory.at(-1)!.sender.id, "agent-north");
    assertEquals(
      (saved.metadata as { coverage: { endMessageId: string } }).coverage
        .endMessageId,
      saved.sourceEndMessageId,
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("consolidation SQL statement budget uses batches for a 65-message source", async () => {
  const statements: { sql: string; params?: unknown[] }[] = [];
  const run = await fixture(
    (_input, call) => call === 1 ? stop("Remembered.") : tool(memoryProposal()),
    { statements },
  );
  try {
    await setupThread(run);
    for (let index = 0; index < 64; index++) {
      await createHumanMessage(run, {
        id: `message:sql:${index}`,
        text: `SOURCE_${index} ` + "history ".repeat(20),
      });
    }
    statements.length = 0;
    await createHumanMessage(run, {
      id: "message:sql:trigger",
      text: "Remember this.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    const reads = statements.filter(({ sql }) =>
      /^\s*SELECT\b/.test(sql) && sql.includes('"nodes"')
    );
    const counts = Object.fromEntries(
      ["message", "participant", "thread", "asset"].map((
        kind,
      ) => [
        kind,
        reads.filter(({ sql, params }) =>
          kind === "asset" ? sql.includes("'asset'") : params?.includes(kind)
        ).length,
      ]),
    );
    console.log("CONSOLIDATION_SQL_READS=" + JSON.stringify(counts));
    // Ceilings measured against the same flow on the pre-change implementation.
    assert(
      counts.message <= 43,
      `message statement budget: ${JSON.stringify(counts)}`,
    );
    assert(
      counts.asset <= 22,
      `asset statement budget: ${JSON.stringify(counts)}`,
    );
    assert(
      counts.participant <= 15,
      `participant statement budget: ${JSON.stringify(counts)}`,
    );
    assert(
      counts.thread <= 13,
      `thread statement budget: ${JSON.stringify(counts)}`,
    );
    await assertNoDeadLetters(run);
  } finally {
    await run.close();
  }
});

Deno.test("ordinary preparation reserves peer-grown history before the provider limit without waiting", async () => {
  let release!: () => void;
  const maintenance = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await fixture(async (input) => {
    if (text(input).includes("Internal memory maintenance")) {
      await maintenance;
      return tool(memoryProposal());
    }
    return stop("Ordinary answer proceeds while memory is pending.");
  }, {
    inputLimit: 180_000,
    memoryConfig: {
      triggerEstimatedTokens: 120_000,
      retainRecentEstimatedTokens: 8_000,
    },
  });
  try {
    await setupThread(run);
    await collection(run, "participant").create({
      id: "agent-south",
      externalId: "south",
      participantType: "agent",
      agentId: "south",
      metadata: {},
    }, { namespace: NAMESPACE });
    await collection(run, "thread").update({
      id: "thread-a",
      set: { participantIds: ["human-a", "agent-north", "agent-south"] },
    }, { namespace: NAMESPACE });
    for (let index = 0; index < 16; index++) {
      const content = await run.engine.content.preparer.prepare(
        "PEER_HISTORY " + "history ".repeat(3_900),
        { namespace: NAMESPACE, idempotencyKey: `peer:${index}` },
      );
      await collection(run, "message").create({
        id: `message:peer:${index}`,
        threadId: "thread-a",
        senderId: "agent-south",
        recipientIds: [],
        content,
        metadata: {},
      }, { namespace: NAMESPACE });
    }
    await createHumanMessage(run, {
      id: "message:north-threshold",
      text: "Please continue.",
      recipientIds: ["agent-north"],
    });
    await eventually(
      run,
      async () =>
        (await checkpoints(run))[0]?.status === "pending" &&
        (await projectMessages(run.engine, NAMESPACE, "thread-a")).some((
          message,
        ) => message.sender.id === "agent-north"),
    );
    const saved = await checkpoint(run);
    const budget = saved.metadata as {
      estimatedTokens: number;
      instructionEstimatedTokens: number;
      historyLimitEstimatedTokens: number;
    };
    assert(
      budget.estimatedTokens + budget.instructionEstimatedTokens <=
        budget.historyLimitEstimatedTokens,
    );
    assertEquals(saved.agentId, "north");
    const ordinary = run.inputs.find((input) =>
      !text(input).includes("Internal memory maintenance")
    );
    assert(ordinary && text(ordinary).includes("PEER_HISTORY"));
    assertEquals(
      saved.status,
      "pending",
      "normal reply did not wait for consolidation",
    );
    release();
    await eventually(
      run,
      async () => (await checkpoints(run))[0]?.status === "ready",
    );
    await assertNoDeadLetters(run);
  } finally {
    release();
    await run.close();
  }
});
