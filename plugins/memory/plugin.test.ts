import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createTestDomainContext } from "../core/internal/testing/context.ts";
import {
  projectActionEvents,
  projectMessages,
} from "../core/internal/testing/projections.ts";
import { defineContextResource } from "@copilotz/copilotz/core";
import {
  createSqlSession,
  type SqlExecutor,
  type SqlSession,
} from "@copilotz/copilotz/events";
import {
  LLM_CALL_ACTION_ID,
  type LlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterResult,
  type LlmJsonObject,
  llmPlugin,
  type LlmToolCall,
  type LlmUsage,
} from "@copilotz/copilotz/llm";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import type { AgentResource } from "@copilotz/copilotz/core";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin, corePlugin } from "@copilotz/copilotz/core";
import {
  CONSOLIDATE_MEMORY_ACTION_ID,
  createLongTermMemoryPlugin,
} from "./plugin.ts";
import {
  type MemoryKindDefinition,
  memorySourceKey,
} from "./authoring/ontology/index.ts";
import type { MemoryEmbed } from "./authoring/contracts/index.ts";

const agent: AgentResource = {
  id: "north",
  name: "North",
  role: "assistant",
  instructions: "Preserve durable meaning and provenance.",
  models: { generate: ["contractModel"] },
};

const usage: LlmUsage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
};

type Responder = (
  request: LlmAdapterCallInput,
  index: number,
) => LlmAdapterResult;

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  requests: LlmAdapterCallInput[];
}>;

type FixtureOptions = Readonly<{
  agent?: AgentResource;
  memoryEnabled?: boolean;
  embed?: MemoryEmbed | false;
  /** Install core text/ask processors. Default is semantic Collections only. */
  withTextWorkflow?: boolean;
  wrapSession?: (session: SqlSession) => SqlSession;
}>;

Deno.test("memory plugin exposes final maps and detached reservation", () => {
  const plugin = createLongTermMemoryPlugin({ models: ["contractModel"] });
  assertEquals(Object.keys(plugin.collections).sort(), [
    "longTermMemory",
    "memoryRecord",
    "memorySpace",
    "memorySpaceAccess",
  ]);
  assertEquals(Object.keys(plugin.actions).sort(), [
    "consolidate_memory",
    "inspect_memory",
    "list_knowledge_spaces",
    "maintainMemory",
    "search_memory",
    "set_memory_status",
  ]);
  assertEquals(Object.keys(plugin.resources.tools).sort(), [
    "consolidate_memory",
    "inspect_memory",
    "list_knowledge_spaces",
    "search_memory",
    "set_memory_status",
  ]);
  assertEquals(
    plugin.actions.consolidate_memory.id,
    CONSOLIDATE_MEMORY_ACTION_ID,
  );
  assertEquals(
    plugin.actions.list_knowledge_spaces.id,
    "copilotz.memory.spaces.list",
  );
  assertEquals(plugin.actions.search_memory.id, "copilotz.memory.search");
  assertEquals(plugin.actions.inspect_memory.id, "copilotz.memory.inspect");
  assertEquals(
    plugin.actions.set_memory_status.id,
    "copilotz.memory.status.set",
  );
  const actions = plugin.actions as Readonly<Record<string, unknown>>;
  for (const [alias, resource] of Object.entries(plugin.resources.tools)) {
    assertEquals(resource.action, alias);
    assertExists(actions[alias]);
  }
  assertEquals(plugin.adapters.memoryEmbedding, {});
  assertEquals(plugin.plugins, [llmPlugin]);
  assertEquals("models" in plugin.resources, false);
  assertEquals("llm" in plugin.adapters, false);
  const processors = Object.values(plugin.processors);
  const reservation = processors.find((processor) =>
    processor.id === "copilotz.memory.reserve"
  );
  assertExists(reservation);
  assertEquals(reservation.settlement, "detached");
});

Deno.test("memory plugin requires ordered Model Resource aliases", () => {
  assertThrows(
    () => createLongTermMemoryPlugin({} as never),
    TypeError,
    "Memory LLM models",
  );
});

Deno.test("disabled memory defers its Model selection requirement", async () => {
  const plugin = createLongTermMemoryPlugin({ enabled: false });
  assertEquals(plugin.processors, {});
  await assertRejects(
    async () =>
      await plugin.actions.maintainMemory.execute({
        checkpointId: "checkpoint-disabled",
        sourceEvent: {} as never,
      }, {} as never),
    TypeError,
    "Memory LLM models",
  );
});

function response(
  _request: LlmAdapterCallInput,
  toolCalls?: readonly LlmToolCall[],
  answer = "",
): LlmAdapterResult {
  return {
    content: answer ? answer : [],
    toolCalls,
    attempts: [{
      status: "completed",
      usage,
      finishReason: toolCalls?.length ? "tool_calls" : "stop",
    }],
    finishReason: toolCalls?.length ? "tool_calls" : "stop",
  };
}

function call(id: string, args: unknown, toolId = "consolidate_memory") {
  return Object.freeze({
    id,
    action: toolId,
    input: structuredClone(args) as LlmJsonObject,
  });
}

async function createFixture(
  responder: Responder,
  extras: readonly ReturnType<typeof definePlugin>[] = [],
  options: FixtureOptions = {},
): Promise<Fixture> {
  let stage = "database";
  try {
    const db = await createTestDatabase({ url: ":memory:" });
    const requests: LlmAdapterCallInput[] = [];
    const llm: LlmAdapter = {
      call(request) {
        const index = requests.length;
        requests.push(request);
        return Object.freeze({
          frames: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          result: Promise.resolve().then(() => responder(request, index)),
        });
      },
    };
    const configuredAgent = options.agent ?? agent;
    const resources = definePlugin({
      id: "test.memory.resources",
      version: "1.0.0",
      resources: {
        agents: { [configuredAgent.id]: configuredAgent },
        models: {
          contractModel: {
            adapter: "contract",
            model: "contract-model",
          },
        },
      },
      adapters: { llm: { contract: llm } },
    });
    stage = "registry";
    const registry = await createPluginRegistry({
      plugins: [
        createLongTermMemoryPlugin({
          models: ["contractModel"],
          enabled: options.memoryEnabled,
          config: {
            triggerEstimatedTokens: 1,
            maxContentEstimatedTokens: 2_000,
            retrievalLimit: 10,
          },
          ...(options.embed === false ? {} : {
            embed: options.embed ??
              ((texts) =>
                Promise.resolve(texts.map((text) => [text.length, 1]))),
          }),
        }),
        options.withTextWorkflow ? corePlugin : coreCollectionsPlugin,
        ...extras,
        resources,
      ],
    });
    stage = "engine";
    const baseSession = createSqlSession(db);
    const engine = await createCopilotzEngine({
      session: options.wrapSession?.(baseSession) ?? baseSession,
      registry,
      defaultDatabaseSchema: `memory_${
        crypto.randomUUID().replaceAll("-", "")
      }`,
      retryBaseMs: 0,
      random: () => 0,
    });
    stage = "thread";
    await createTestDomainContext(engine, "tenant-a")
      .actions.createThread({
        id: "thread-a",
        participants: [
          { id: "user-a", externalId: "user-a", participantType: "human" },
          {
            id: "agent-north",
            externalId: agent.id,
            participantType: "agent",
            agentId: configuredAgent.id,
          },
        ],
      }, { identity: { deduplicationId: "thread-a:create" } });
    return Object.freeze({ db, engine, requests });
  } catch (cause) {
    throw new Error(`Memory fixture failed during ${stage}.`, { cause });
  }
}

async function addMessage(
  fixture: Fixture,
  id: string,
  sender: "user" | "agent",
  text: string,
) {
  return await createTestDomainContext(
    fixture.engine,
    "tenant-a",
  ).actions
    .createThreadMessage({
      id,
      threadId: "thread-a",
      sender: sender === "user"
        ? { id: "user-a", externalId: "user-a", participantType: "human" }
        : {
          id: "agent-north",
          externalId: agent.id,
          participantType: "agent",
          agentId: agent.id,
        },
      content: text,
    }, {
      identity: {
        correlationId: `correlation:${id}`,
        deduplicationId: `${id}:create`,
      },
    });
}

async function trigger(fixture: Fixture, suffix = "a") {
  try {
    await addMessage(
      fixture,
      `message-user-${suffix}`,
      "user",
      `Durable user evidence ${suffix}.`,
    );
  } catch (cause) {
    throw new Error("Memory trigger failed on user message.", { cause });
  }
  try {
    return await addMessage(
      fixture,
      `message-agent-${suffix}`,
      "agent",
      `Durable agent evidence ${suffix}.`,
    );
  } catch (cause) {
    throw new Error("Memory trigger failed on agent message.", { cause });
  }
}

async function waitForCheckpoint(
  fixture: Fixture,
  status: "ready" | "failed" | "cancelled",
  sequence = 1,
) {
  const scoped = fixture.engine.collections.withScope({
    namespace: "tenant-a",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const values = await scoped.long_term_memory.list({
      where: { threadId: "thread-a", agentId: agent.id },
      limit: 100,
    });
    const found = values.find((item) =>
      item.sequence === sequence && item.status === status
    );
    if (found) return found;
    await fixture.engine.recover({ namespace: "tenant-a", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const dead = await fixture.engine.deliveries.list({
    namespace: "tenant-a",
  });
  throw new Error(
    `Timed out waiting for checkpoint ${sequence}/${status}: ${
      JSON.stringify({
        deliveries: dead.map((delivery) => ({
          consumerId: delivery.consumerId,
          status: delivery.status,
          attempts: delivery.attempts,
          lastError: delivery.lastError,
        })),
        checkpoints: await scoped.long_term_memory.list({ limit: 100 }),
        requests: fixture.requests.length,
      })
    }`,
  );
}

async function close(fixture: Fixture) {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function waitForSubjectSettlement(
  fixture: Fixture,
  subjectId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await fixture.engine.events.list({
      namespace: "tenant-a",
      limit: 1_000,
    });
    const root = [...events].reverse().find((event) =>
      event.subject?.id === subjectId
    );
    if (root) {
      const settlement = await fixture.engine.events.settlement(
        "tenant-a",
        root.id,
      );
      if (settlement.unsettled === 0 && settlement.deadLetters === 0) return;
      if (settlement.deadLetters > 0) {
        throw new Error(`Subject '${subjectId}' dead-lettered.`);
      }
    }
    await fixture.engine.recover({ namespace: "tenant-a", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for subject '${subjectId}'.`);
}

async function waitForMaintenanceSettlement(fixture: Fixture) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lifecycle = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      "copilotz.memory.maintenance.run",
    );
    const terminal = lifecycle.filter((event) => event.status !== "invoked");
    if (terminal.length) return terminal;
    await fixture.engine.recover({ namespace: "tenant-a", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for memory maintenance settlement.");
}

async function projectToolLifecycle(
  fixture: Fixture,
): Promise<Array<Record<string, unknown> & { status: string }>> {
  const definitions = [
    ["search_memory", "copilotz.memory.search"],
    ["inspect_memory", "copilotz.memory.inspect"],
    ["set_memory_status", "copilotz.memory.status.set"],
    ["list_knowledge_spaces", "copilotz.memory.spaces.list"],
  ] as const;
  const projected: Array<Record<string, unknown> & { status: string }> = [];
  for (const [alias, actionId] of definitions) {
    const events = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      actionId,
    );
    const latest = new Map<string, (typeof events)[number]>();
    for (const event of events) latest.set(event.actionRunId, event);
    projected.push(...[...latest.values()].map((event) => ({
      tool: { id: alias },
      input: event.input,
      ...(event.status === "completed" ? { output: event.output } : {}),
      status: event.status === "invoked" ? "running" : event.status,
      ...(event.status === "failed" || event.status === "cancelled"
        ? { safeError: event.error }
        : {}),
    })));
  }
  return projected;
}

async function waitForToolLifecycle(fixture: Fixture, count: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const executions = await projectToolLifecycle(fixture);
    if (
      executions.length === count &&
      executions.every((execution) => execution.status !== "running")
    ) return executions;
    await fixture.engine.recover({ namespace: "tenant-a", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} Tool Action terminals.`);
}

Deno.test("native consolidation uses one internal tool grant and emits no public workflow messages", async () => {
  const fixture = await createFixture((request) =>
    response(request, [call("memory-call", {
      outcome: "changes",
      entities: [{
        localId: "copilotz",
        kind: "entity.project",
        summary: "Copilotz is the framework under active refactor.",
        name: "Copilotz",
        sources: [{ type: "message", id: "message-agent-a" }],
      }],
      intents: [{
        localId: "objective",
        kind: "intent.objective",
        summary: "Ship the event-native memory refactor.",
        status: "active",
        target: { localId: "copilotz" },
        sources: [{ type: "message", id: "message-agent-a" }],
      }],
      relations: [{
        from: { localId: "objective" },
        type: "about",
        to: { localId: "copilotz" },
      }],
    })])
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "ready");
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    const records = await scoped.memory_record.list({
      where: { consolidationId: checkpoint.id },
      limit: 100,
    });
    assertEquals(records.map((item) => item.form).sort(), ["entity", "intent"]);
    assertEquals(records.every((item) => item.layer === undefined), true);
    assertEquals(record(checkpoint.metadata).continuity, undefined);

    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
    assertEquals(
      record(record(maintenance[0].input).sourceEvent).type,
      "long_term_memory.created",
    );
    const consolidation = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      CONSOLIDATE_MEMORY_ACTION_ID,
    );
    assertEquals(consolidation.map((event) => event.status), [
      "invoked",
      "completed",
    ]);
    assertEquals(consolidation[0].metadata, {
      memoryCheckpointId: checkpoint.id,
    });
    const llm = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      LLM_CALL_ACTION_ID,
    );
    assertEquals(llm.map((event) => event.status), ["invoked", "completed"]);
    assertEquals(record(llm[0].metadata).schema, "copilotz.memory.llm-call.v1");
    assertEquals(record(llm[0].input).models, ["contractModel"]);
    assertEquals(record(llm[0].input).mode, "generate");
    assertEquals(record(record(llm[1]).output).adapter, "contract");
    assertEquals(record(record(llm[1]).output).providerModel, "contract-model");
    const messages = await projectMessages(
      fixture.engine,
      "tenant-a",
      "thread-a",
      { limit: 100 },
    );
    assertEquals(messages.map((item) => item.id), [
      "message-user-a",
      "message-agent-a",
    ]);
    assertEquals(fixture.requests[0].request.tools?.length, 1);
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].request.messages),
      "Internal memory maintenance",
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("explicit no_changes settles the cutover without semantic records", async () => {
  const fixture = await createFixture((request) =>
    response(request, [call("none", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "ready");
    assertEquals(record(checkpoint.metadata).result, {
      outcome: "no_changes",
      created: 0,
      reused: 0,
      lifecycleChanged: 0,
    });
    const records = await fixture.engine.collections.withScope({
      namespace: "tenant-a",
    }).memory_record.list({ limit: 100 });
    assertEquals(records.length, 0);
  } finally {
    await close(fixture);
  }
});

Deno.test("a missing consolidation call receives one bounded internal repair", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, undefined, "I should not answer publicly.")
      : response(request, [call("repair", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(fixture.requests.length, 2);
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].request.messages),
      "did not call consolidate_memory",
    );
    const messages = await projectMessages(
      fixture.engine,
      "tenant-a",
      "thread-a",
      { limit: 100 },
    );
    assertEquals(messages.length, 2);
  } finally {
    await close(fixture);
  }
});

Deno.test("invalid tool input receives one bounded contract repair", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [call("invalid", { entities: [] })])
      : response(request, [call("valid", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(fixture.requests.length, 2);
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].request.messages),
      "consolidate_memory input is invalid",
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("an unauthorized tool call receives one bounded contract repair", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [call("unauthorized", {}, "terminal")])
      : response(request, [call("repair", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(fixture.requests.length, 2);
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
    assertEquals(fixture.requests[0].request.tools?.map((tool) => tool.name), [
      "consolidate_memory",
    ]);
  } finally {
    await close(fixture);
  }
});

Deno.test("semantic consolidation errors propagate without another LLM call", async () => {
  const fixture = await createFixture((request) =>
    response(request, [call("invalid-semantics", {
      outcome: "changes",
      entities: [{
        localId: "bad",
        kind: "entity.project",
        summary: "Unauthorized evidence",
        name: "Bad",
        sources: [{ type: "message", id: "outside-range" }],
      }],
    })])
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "failed");
    assertEquals(fixture.requests.length, 1);
    assertStringIncludes(
      String(record(checkpoint.error).message),
      "unauthorized evidence source",
    );
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["failed"]);
  } finally {
    await close(fixture);
  }
});

Deno.test("exhausted repair fails the checkpoint and the next reservation uses a new identity", async () => {
  const fixture = await createFixture((request) =>
    response(request, undefined, "wrong output")
  );
  try {
    await trigger(fixture, "a");
    const failed = await waitForCheckpoint(fixture, "failed", 1);
    assertEquals(failed.sourceEndMessageId, "message-agent-a");
    await trigger(fixture, "b");
    const second = await waitForCheckpoint(fixture, "failed", 2);
    assert(second.id !== failed.id);
    assertEquals(second.sourceEndMessageId, "message-agent-b");
  } finally {
    await close(fixture);
  }
});

Deno.test("frozen application evidence is captured once and reused across repair", async () => {
  let captures = 0;
  const workspace = defineContextResource({
    id: "compass.workspace",
    type: "context",
    purposes: ["memory_consolidation"],
    contribute() {
      captures++;
      return {
        id: "shared-doc",
        title: "Compass shared document",
        role: "evidence",
        content: { type: "text", text: `frozen version ${captures}` },
        source: {
          type: "collection_record",
          collection: "sharedDocument",
          id: "doc-a",
          version: 7,
        },
      };
    },
  });
  const plugin = definePlugin({
    id: "test.compass",
    version: "1.0.0",
    resources: { promptContext: { [workspace.id]: workspace } },
  });
  const fixture = await createFixture(
    (request, index) =>
      index === 0
        ? response(request, undefined, "missing")
        : response(request, [call("repair", {
          outcome: "changes",
          entities: [{
            localId: "doc",
            kind: "entity.document",
            summary: "The Compass shared document is version seven.",
            name: "Compass shared document",
            sources: [{
              type: "collection_record",
              collection: "sharedDocument",
              id: "doc-a",
              version: 7,
            }],
          }],
        })]),
    [plugin],
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "ready");
    assertEquals(captures, 1);
    assertEquals(Array.isArray(checkpoint.contextSnapshot), true);
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].request.messages),
      "frozen version 1",
    );
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].request.messages),
      "frozen version 1",
    );
    assertEquals(
      JSON.stringify(fixture.requests[1].request.messages).includes(
        "frozen version 2",
      ),
      false,
    );
    const recordValue =
      (await fixture.engine.collections.withScope({ namespace: "tenant-a" })
        .memory_record.list({ limit: 10 }))[0];
    assertEquals(
      memorySourceKey(
        (record(recordValue.provenance).sources as Array<
          Parameters<typeof memorySourceKey>[0]
        >)[0],
      ),
      memorySourceKey({
        type: "collection_record",
        collection: "sharedDocument",
        id: "doc-a",
        version: 7,
      }),
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("recovery and duplicate delivery do not duplicate semantic records", async () => {
  const fixture = await createFixture((request) =>
    response(request, [call("record", {
      outcome: "changes",
      entities: [{
        localId: "stable",
        kind: "entity.project",
        summary: "One stable memory record.",
        name: "Stable",
        sources: [{ type: "message", id: "message-agent-a" }],
      }],
    })])
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "ready");
    await fixture.engine.recover({ namespace: "tenant-a", limit: 1_000 });
    const records = await fixture.engine.collections.withScope({
      namespace: "tenant-a",
    }).memory_record.list({
      where: { consolidationId: checkpoint.id },
      limit: 100,
    });
    assertEquals(records.length, 1);
    assertEquals(records[0].id, `${checkpoint.id}:record:stable`);
  } finally {
    await close(fixture);
  }
});

Deno.test("corrections preserve temporal history and create explicit supersession", async () => {
  const entityId = "memory:thread-a:north:1:record:project";
  const oldStateId = "memory:thread-a:north:1:record:state";
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [call("first", {
        outcome: "changes",
        entities: [{
          localId: "project",
          kind: "entity.project",
          summary: "Compass is the active project.",
          name: "Compass",
          sources: [{ type: "message", id: "message-agent-a" }],
        }],
        assertions: [{
          localId: "state",
          kind: "assertion.state",
          summary: "Compass migration is blocked.",
          subject: { localId: "project" },
          predicate: "migration_status",
          object: { value: "blocked" },
          epistemic: { basis: "reported", stance: "affirmed" },
          sources: [{ type: "message", id: "message-agent-a" }],
        }],
      })])
      : response(request, [call("second", {
        outcome: "changes",
        assertions: [{
          localId: "state-corrected",
          kind: "assertion.state",
          summary: "Compass migration is active.",
          subject: { memoryId: entityId },
          predicate: "migration_status",
          object: { value: "active" },
          epistemic: { basis: "observed", stance: "affirmed" },
          sources: [{ type: "message", id: "message-agent-b" }],
        }],
        lifecycle: [{
          target: { memoryId: oldStateId },
          status: "superseded",
          replacement: { localId: "state-corrected" },
          sources: [{ type: "message", id: "message-agent-b" }],
        }],
      })])
  );
  try {
    await trigger(fixture, "a");
    await waitForCheckpoint(fixture, "ready", 1);
    await trigger(fixture, "b");
    await waitForCheckpoint(fixture, "ready", 2);
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    const oldState = await scoped.memory_record.get({ id: oldStateId });
    const corrected = await scoped.memory_record.get({
      id: "memory:thread-a:north:2:record:state-corrected",
    });
    assertEquals(oldState?.status, "superseded");
    assertEquals(corrected?.status, "current");
    assertExists(record(oldState?.temporal).invalidatedAt);
    const relations = await scoped.memory_record.relations.list({
      types: ["contradicts", "supersedes"],
      limit: 100,
    });
    assert(relations.some((item) => item.type === "contradicts"));
    assert(relations.some((item) => item.type === "supersedes"));
  } finally {
    await close(fixture);
  }
});

Deno.test("a settled provider failure propagates without another LLM call", async () => {
  const fixture = await createFixture(() => {
    throw new Error("temporary provider failure");
  });
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "failed");
    assertEquals(fixture.requests.length, 1);
    assertStringIncludes(
      String(record(checkpoint.error).message),
      "temporary provider failure",
    );
    const llm = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      LLM_CALL_ACTION_ID,
    );
    assertEquals(llm.map((event) => event.status), ["invoked", "failed"]);
    const messages = await projectMessages(
      fixture.engine,
      "tenant-a",
      "thread-a",
      { limit: 100 },
    );
    assertEquals(messages.length, 2);
  } finally {
    await close(fixture);
  }
});

Deno.test("AbortError cancels the checkpoint without contract repair", async () => {
  const fixture = await createFixture(() => {
    throw new DOMException("provider call aborted", "AbortError");
  });
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "cancelled");
    assertEquals(fixture.requests.length, 1);
    assertEquals(record(checkpoint.error).name, "AbortError");
    const llm = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      LLM_CALL_ACTION_ID,
    );
    assertEquals(llm.map((event) => event.status), ["invoked", "cancelled"]);
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["cancelled"]);
  } finally {
    await close(fixture);
  }
});

Deno.test("delivery retry settles a checkpoint from its durable cancelled Action", async () => {
  let settlementInterruptions = 0;
  let cancellationReachedProvider = false;
  const fixture = await createFixture(
    () => {
      cancellationReachedProvider = true;
      throw new DOMException("provider call aborted", "AbortError");
    },
    [],
    {
      wrapSession(session) {
        return {
          query: session.query,
          transaction(operation) {
            return session.transaction((transaction) => {
              const query: SqlExecutor["query"] = (sql, params) => {
                const eventBody = params?.[3];
                if (
                  cancellationReachedProvider &&
                  settlementInterruptions === 0 &&
                  typeof eventBody === "string" &&
                  eventBody.includes('"operation":"update"') &&
                  eventBody.includes('"id":"memory:thread-a:north:1"') &&
                  eventBody.includes('"status":"cancelled"')
                ) {
                  settlementInterruptions++;
                  throw new Error(
                    "injected interruption after durable Action cancellation",
                  );
                }
                return transaction.query(sql, params);
              };
              return operation({ query });
            });
          },
        };
      },
    },
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "cancelled");
    assertEquals(record(checkpoint.error).name, "AbortError");
    assertEquals(settlementInterruptions, 1);
    assertEquals(fixture.requests.length, 1);

    const maintenance = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      "copilotz.memory.maintenance.run",
    );
    assertEquals(maintenance.map((event) => event.status), [
      "invoked",
      "cancelled",
    ]);
    const deliveries = await fixture.engine.deliveries.list({
      namespace: "tenant-a",
    });
    const preparation = deliveries.find((delivery) =>
      delivery.consumerId === "processor:copilotz.memory.prepare-attempt"
    );
    assertExists(preparation);
    assertEquals(preparation.status, "succeeded");
    assertEquals(preparation.attempts, 2);
  } finally {
    await close(fixture);
  }
});

Deno.test("failed context capture retries before provider execution and freezes the successful version", async () => {
  let captures = 0;
  const resource = defineContextResource({
    id: "retrying.workspace",
    type: "context",
    purposes: ["memory_consolidation"],
    contribute() {
      captures++;
      if (captures === 1) throw new Error("workspace temporarily unavailable");
      return {
        id: "workspace",
        title: "Workspace",
        role: "context",
        content: `captured version ${captures}`,
      };
    },
  });
  const plugin = definePlugin({
    id: "test.retrying-context",
    version: "1.0.0",
    resources: { promptContext: { [resource.id]: resource } },
  });
  const fixture = await createFixture(
    (request) => response(request, [call("settle", { outcome: "no_changes" })]),
    [plugin],
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "ready");
    assertEquals(captures, 2);
    assertEquals(fixture.requests.length, 1);
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].request.messages),
      "captured version 2",
    );
    assertEquals(Array.isArray(checkpoint.contextSnapshot), true);
  } finally {
    await close(fixture);
  }
});

Deno.test("candidate retrieval starts after extraction and queries each proposed semantic record", async () => {
  let extracted = false;
  const embedded: string[][] = [];
  const fixture = await createFixture(
    (request) => {
      extracted = true;
      return response(request, [call("extract", {
        outcome: "changes",
        entities: [{
          localId: "project",
          kind: "entity.project",
          summary: "Compass is the active client project.",
          name: "Compass",
          sources: [{ type: "message", id: "message-agent-a" }],
        }],
      })]);
    },
    [],
    {
      embed(texts) {
        assertEquals(extracted, true);
        embedded.push([...texts]);
        return Promise.resolve(texts.map((text) => [text.length, 1]));
      },
    },
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(embedded, [
      ["Compass is the active client project."],
      ["Compass is the active client project."],
    ]);
  } finally {
    await close(fixture);
  }
});

Deno.test("semantic duplicates reuse one record and merge exact provenance", async () => {
  const fixture = await createFixture((request, index) =>
    response(request, [call(`duplicate-${index}`, {
      outcome: "changes",
      entities: [{
        localId: index === 0 ? "project-first" : "project-again",
        kind: "entity.project",
        summary: index === 0
          ? "Compass is the active project."
          : "The active project is Compass.",
        name: "Compass",
        sources: [{
          type: "message",
          id: index === 0 ? "message-agent-a" : "message-agent-b",
        }],
      }],
    })])
  );
  try {
    await trigger(fixture, "a");
    await waitForCheckpoint(fixture, "ready", 1);
    await trigger(fixture, "b");
    const checkpoint = await waitForCheckpoint(fixture, "ready", 2);
    const records = await fixture.engine.collections.withScope({
      namespace: "tenant-a",
    }).memory_record.list({ limit: 100 });
    assertEquals(records.length, 1);
    assertEquals(record(checkpoint.metadata).result, {
      outcome: "changes",
      created: 0,
      reused: 1,
      lifecycleChanged: 0,
      unresolved: 0,
    });
    assertEquals(
      (record(records[0].provenance).sources as Array<Record<string, unknown>>)
        .map((source) => source.id),
      ["message-agent-a", "message-agent-b"],
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("ambiguous lifecycle matches remain unresolved without mutating history", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [call("seed-ambiguous", {
        outcome: "changes",
        intents: ["one", "two"].map((localId) => ({
          localId,
          kind: "intent.action",
          summary: `Compass migration action ${localId}.`,
          status: "active",
          sources: [{ type: "message", id: "message-agent-a" }],
        })),
      })])
      : response(request, [call("ambiguous-change", {
        outcome: "changes",
        lifecycle: [{
          target: {
            match: {
              form: "intent",
              kind: "intent.action",
              query: "Compass migration action",
            },
          },
          status: "completed",
          sources: [{ type: "message", id: "message-agent-b" }],
        }],
      })])
  );
  try {
    await trigger(fixture, "a");
    await waitForCheckpoint(fixture, "ready", 1);
    await trigger(fixture, "b");
    const checkpoint = await waitForCheckpoint(fixture, "ready", 2);
    const records = await fixture.engine.collections.withScope({
      namespace: "tenant-a",
    }).memory_record.list({
      where: { form: "intent", kind: "intent.action" },
      limit: 100,
    });
    assertEquals(records.map((item) => item.status), ["active", "active"]);
    assertEquals(record(checkpoint.metadata).result, {
      outcome: "changes",
      created: 0,
      reused: 0,
      lifecycleChanged: 0,
      unresolved: 1,
    });
    assertEquals(
      (record(checkpoint.metadata).unresolvedReconciliations as unknown[])
        .length,
      1,
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("memory-kind validation failures propagate without LLM repair", async () => {
  const kind: MemoryKindDefinition = {
    id: "entity.project",
    form: "entity",
    description: "A Compass project with a canonical name.",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { const: "Compass" } },
    },
  };
  const plugin = definePlugin({
    id: "test.memory-kind",
    version: "1.0.0",
    resources: { memoryKinds: { [kind.id]: kind } },
  });
  const fixture = await createFixture(
    (request) =>
      response(request, [call("invalid-kind", {
        outcome: "changes",
        entities: [{
          localId: "project",
          kind: "entity.project",
          summary: "The project has a non-canonical name.",
          name: "Other",
          sources: [{ type: "message", id: "message-agent-a" }],
        }],
      })]),
    [plugin],
  );
  try {
    await trigger(fixture);
    const checkpoint = await waitForCheckpoint(fixture, "failed");
    assertEquals(fixture.requests.length, 1);
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].request.messages),
      "A Compass project with a canonical name.",
    );
    assertStringIncludes(
      String(record(checkpoint.error).message),
      "does not satisfy kind 'entity.project'",
    );
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["failed"]);
  } finally {
    await close(fixture);
  }
});

Deno.test("memory query tools enforce thread access, explain provenance, and preserve retracted history", async () => {
  const queryAgent: AgentResource = {
    ...agent,
    capabilities: {
      tools: [
        "search_memory",
        "inspect_memory",
        "set_memory_status",
        "list_knowledge_spaces",
      ],
    },
  };
  const fixture = await createFixture(
    (request, index) => {
      if (index === 0) {
        return response(request, [call("search", {
          query: "Compass project",
        }, "search_memory")]);
      }
      if (index === 1) {
        return response(request, [call("inspect", {
          id: "memory-visible",
        }, "inspect_memory")]);
      }
      if (index === 2) {
        return response(request, [call("retract", {
          id: "memory-visible",
          status: "retracted",
        }, "set_memory_status")]);
      }
      if (index === 3) {
        return response(request, [call("spaces", {}, "list_knowledge_spaces")]);
      }
      return response(request, undefined, "Memory reviewed.");
    },
    [],
    {
      agent: queryAgent,
      memoryEnabled: false,
      embed: false,
      withTextWorkflow: true,
    },
  );
  try {
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    for (
      const [id, threadId] of [
        ["space-visible", "thread-a"],
        ["space-hidden", "thread-other"],
      ] as const
    ) {
      await scoped.memory_space.create({
        id,
        name: id,
        scopeType: "thread",
        scopeId: threadId,
        ...(threadId === "thread-a" ? { threadId } : {}),
        access: "read_write",
        defaultWrite: true,
      });
    }
    await scoped.memory_space_access.create({
      id: "grant-visible",
      threadId: "thread-a",
      memorySpaceId: "space-visible",
      access: "read_write",
      defaultWrite: true,
    });
    for (
      const [id, memorySpaceId, sequence] of [
        ["checkpoint:memory-visible", "space-visible", 1],
        ["checkpoint:memory-hidden", "space-hidden", 2],
      ] as const
    ) {
      await scoped.long_term_memory.create({
        id,
        threadId: "thread-a",
        schemaVersion: "4",
        strategy: "semantic_graph",
        status: "ready",
        memorySpaceId,
        readMemorySpaceIds: [memorySpaceId],
        writeMemorySpaceIds: [memorySpaceId],
        defaultWriteMemorySpaceId: memorySpaceId,
        sequence,
        agentId: "north",
        sourceStartMessageId: "source-message",
        sourceEndMessageId: "source-message",
        content: [],
      });
    }
    const memoryInput = (
      id: string,
      memorySpaceId: string,
      summary: string,
    ) => ({
      id,
      memorySpaceId,
      consolidationId: `checkpoint:${id}`,
      createdByAgentId: "north",
      originThreadId: "thread-a",
      form: "assertion",
      kind: "assertion.state",
      summary,
      status: "current",
      temporal: { recordedAt: "2026-08-14T00:00:00.000Z" },
      epistemic: { basis: "observed", stance: "affirmed" },
      provenance: {
        sources: [{ type: "message", id: "source-message" }],
        assertedBy: { type: "participant", id: "user-a" },
        recordedBy: { type: "agent", id: "north" },
        consolidationId: `checkpoint:${id}`,
      },
      data: { subject: "Compass", predicate: "state", object: "active" },
    });
    await scoped.memory_record.create(
      memoryInput(
        "memory-visible",
        "space-visible",
        "Compass project is active.",
      ),
    );
    await scoped.memory_record.create(
      memoryInput(
        "memory-hidden",
        "space-hidden",
        "Compass hidden tenant fact.",
      ),
    );
    await fixture.engine.collections.transaction({
      operationKey: "cross-space-relation:create",
      namespace: "tenant-a",
      execute: ({ relations }) =>
        relations.upsert({
          id: "cross-space-relation",
          type: "contradicts",
          source: { type: "memory_record", id: "memory-visible" },
          target: { type: "memory_record", id: "memory-hidden" },
          metadata: { threadId: "thread-a" },
        }),
    });

    await createTestDomainContext(
      fixture.engine,
      "tenant-a",
    ).actions.createThreadMessage({
      id: "message-query",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      recipientIds: ["agent-north"],
      content: "Review and retract the visible memory.",
    }, {
      identity: {
        correlationId: "memory-query",
        deduplicationId: "memory-query:message",
      },
    });
    await waitForSubjectSettlement(fixture, "message-query");

    const executions = await waitForToolLifecycle(fixture, 4);
    assertEquals(executions.map((execution) => execution.status), [
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    const outputs = Object.fromEntries(
      executions.map((execution) =>
        [
          String(record(execution.tool).id),
          record(execution.output),
        ] as const
      ),
    );
    assertEquals(
      (outputs.search_memory.memories as Array<Record<string, unknown>>).map(
        (memory) => memory.id,
      ),
      ["memory-visible"],
    );
    assertEquals(
      (outputs.inspect_memory.relations as Array<Record<string, unknown>>).some(
        (
          relation,
        ) => relation.id === "cross-space-relation",
      ),
      false,
    );
    assertEquals(
      record(record(outputs.inspect_memory.memory).provenance).assertedBy,
      { type: "participant", id: "user-a" },
    );
    assertEquals(
      (outputs.list_knowledge_spaces.knowledgeSpaces as Array<
        Record<string, unknown>
      >).map((ta) => ta.id),
      ["space-visible"],
    );
    const updated = await scoped.memory_record.get({ id: "memory-visible" });
    assertEquals(updated?.status, "retracted");
    assertExists(record(updated?.temporal).invalidatedAt);
  } finally {
    await close(fixture);
  }
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
