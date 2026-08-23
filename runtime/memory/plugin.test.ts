import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectActionEvents,
  projectMessages,
} from "../../runtime/testing/projections.ts";
import type { Agent } from "../resources/index.ts";
import type { ValidateCollectionRecord } from "../domain/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import type { ChatRequest, ChatResponse, TokenUsage } from "../llm/types.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineContextResource } from "../context/index.ts";
import {
  coreCollectionsPlugin,
  corePlugin,
} from "@copilotz/copilotz/plugins/core";
import {
  defineLlmProviderResource,
  generateFromChat,
  type LlmChat,
} from "../llm/index.ts";
import {
  CONSOLIDATE_MEMORY_ACTION_ID,
  createLongTermMemoryPlugin,
} from "./plugin.ts";
import { type MemoryKindDefinition, memorySourceKey } from "./ontology.ts";
import type { MemoryEmbed } from "./types.ts";

const agent: Agent = {
  id: "north",
  name: "North",
  role: "assistant",
  instructions: "Preserve durable meaning and provenance.",
  runtime: { provider: "openai", model: "contract-model" },
};

const usage: TokenUsage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  source: "provider",
  status: "completed",
};

type Responder = (request: ChatRequest, index: number) => ChatResponse;

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  requests: ChatRequest[];
}>;

type FixtureOptions = Readonly<{
  agent?: Agent;
  memoryEnabled?: boolean;
  embed?: MemoryEmbed | false;
  validateCollection?: ValidateCollectionRecord;
  /** Install core text/ask processors. Default is semantic Collections only. */
  withTextWorkflow?: boolean;
}>;

Deno.test("memory plugin exposes final maps and detached reservation", () => {
  const plugin = createLongTermMemoryPlugin();
  assertEquals(Object.keys(plugin.collections).sort(), [
    "longTermMemory",
    "memoryRecord",
    "memorySpace",
    "memorySpaceAccess",
  ]);
  assertEquals(Object.keys(plugin.actions).sort(), [
    "consolidateMemory",
    "maintainMemory",
  ]);
  assertEquals(Object.keys(plugin.resources.tools).sort(), [
    "consolidateMemory",
    "inspectMemory",
    "listMemorySpaces",
    "searchMemory",
    "setMemoryStatus",
  ]);
  assertEquals(plugin.adapters.memoryEmbedding, {});
  const processors = Object.values(plugin.processors);
  const reservation = processors.find((processor) =>
    processor.id === "copilotz.memory.reserve"
  );
  assertExists(reservation);
  assertEquals(reservation.settlement, "detached");
});

function response(
  request: ChatRequest,
  toolCalls?: ChatResponse["toolCalls"],
  answer = "",
): ChatResponse {
  return {
    prompt: request.messages,
    answer,
    toolCalls,
    tokens: 2,
    usage,
    provider: "openai",
    model: "contract-model",
    finishReason: toolCalls?.length ? "tool_calls" : "stop",
  };
}

function call(id: string, args: unknown, toolId = "consolidate_memory") {
  return {
    id,
    tool: { id: toolId, name: toolId },
    args: JSON.stringify(args),
  };
}

async function createFixture(
  responder: Responder,
  extras: readonly ReturnType<typeof definePlugin>[] = [],
  options: FixtureOptions = {},
): Promise<Fixture> {
  let stage = "database";
  try {
    const db = await createTestDatabase({ url: ":memory:" });
    const requests: ChatRequest[] = [];
    const chat: LlmChat = (request) => {
      const index = requests.length;
      requests.push(request);
      return Promise.resolve(responder(request, index));
    };
    const provider = defineLlmProviderResource({
      id: "openai",
      type: "llm",
      generate: generateFromChat(chat),
    });
    const configuredAgent = options.agent ?? agent;
    const resources = definePlugin({
      id: "test.memory.resources",
      version: "1.0.0",
      resources: { agents: { [configuredAgent.id]: configuredAgent } },
      adapters: { llm: { [provider.id]: provider } },
    });
    stage = "registry";
    const registry = await createPluginRegistry({
      plugins: [
        createLongTermMemoryPlugin({
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
    const engine = await createCopilotzEngine({
      session: createSqlSession(db),
      registry,
      defaultDatabaseSchema: `memory_${
        crypto.randomUUID().replaceAll("-", "")
      }`,
      retryBaseMs: 0,
      random: () => 0,
      validateCollection: options.validateCollection,
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
  status: "ready" | "failed",
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
  const events = await projectActionEvents(
    fixture.engine,
    "tenant-a",
    "copilotz.core.tool.call",
  );
  const latest = new Map<string, (typeof events)[number]>();
  for (const event of events) latest.set(event.actionRunId, event);
  return [...latest.values()].map((event) => {
    const input = record(event.input);
    const output = "output" in event ? record(event.output) : {};
    return {
      ...input,
      ...output,
      status: event.status === "invoked"
        ? "running"
        : event.status === "completed"
        ? String(output.status ?? "completed")
        : event.status,
      ...(event.status === "failed" || event.status === "cancelled"
        ? { safeError: event.error }
        : {}),
    } as Record<string, unknown> & { status: string };
  });
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
    const consolidation = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      CONSOLIDATE_MEMORY_ACTION_ID,
    );
    assertEquals(consolidation.map((event) => event.status), [
      "invoked",
      "completed",
    ]);
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
    assertEquals(fixture.requests[0].tools?.length, 1);
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].messages),
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
      JSON.stringify(fixture.requests[1].messages),
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

Deno.test("invalid arguments use ordinary tool validation and then repair", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [call("invalid", {
        outcome: "changes",
        entities: [{
          localId: "bad",
          kind: "entity.project",
          summary: "Unauthorized evidence",
          name: "Bad",
          sources: [{ type: "message", id: "outside-range" }],
        }],
      })])
      : response(request, [call("valid", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(fixture.requests.length, 2);
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].messages),
      "unauthorized evidence source",
    );
  } finally {
    await close(fixture);
  }
});

Deno.test("multiple or unauthorized calls are rejected before any tool mutation", async () => {
  const fixture = await createFixture((request, index) =>
    index === 0
      ? response(request, [
        call("one", { outcome: "no_changes" }),
        call("two", {}, "terminal"),
      ])
      : response(request, [call("repair", { outcome: "no_changes" })])
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
    assertEquals(fixture.requests[0].tools?.map((tool) => tool.function.name), [
      "consolidate_memory",
    ]);
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
      JSON.stringify(fixture.requests[0].messages),
      "frozen version 1",
    );
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].messages),
      "frozen version 1",
    );
    assertEquals(
      JSON.stringify(fixture.requests[1].messages).includes("frozen version 2"),
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
    const relations = await fixture.engine.relations.list({
      namespace: "tenant-a",
      types: ["contradicts", "supersedes"],
      limit: 100,
    });
    assert(relations.some((item) => item.type === "contradicts"));
    assert(relations.some((item) => item.type === "supersedes"));
  } finally {
    await close(fixture);
  }
});

Deno.test("provider failure receives one internal repair without publishing an answer", async () => {
  const fixture = await createFixture((request, index) => {
    if (index === 0) throw new Error("temporary provider failure");
    return response(request, [call("repair", { outcome: "no_changes" })]);
  });
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertEquals(fixture.requests.length, 2);
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
      JSON.stringify(fixture.requests[0].messages),
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

Deno.test("overridden memory-kind schemas use ordinary tool failure and repair", async () => {
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
    (request, index) =>
      index === 0
        ? response(request, [call("invalid-kind", {
          outcome: "changes",
          entities: [{
            localId: "project",
            kind: "entity.project",
            summary: "The project has a non-canonical name.",
            name: "Other",
            sources: [{ type: "message", id: "message-agent-a" }],
          }],
        })])
        : response(request, [call("repair", { outcome: "no_changes" })]),
    [plugin],
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "ready");
    assertStringIncludes(
      JSON.stringify(fixture.requests[0].messages),
      "A Compass project with a canonical name.",
    );
    assertStringIncludes(
      JSON.stringify(fixture.requests[1].messages),
      "does not satisfy kind 'entity.project'",
    );
    const maintenance = await waitForMaintenanceSettlement(fixture);
    assertEquals(maintenance.map((event) => event.status), ["completed"]);
  } finally {
    await close(fixture);
  }
});

Deno.test("memory query tools enforce thread access, explain provenance, and preserve retracted history", async () => {
  const queryAgent: Agent = {
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
    await fixture.engine.relations.create({
      namespace: "tenant-a",
      id: "cross-space-relation",
      type: "contradicts",
      source: { type: "memory_record", id: "memory-visible" },
      target: { type: "memory_record", id: "memory-hidden" },
      threadId: "thread-a",
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
      await Promise.all(executions.map(async (execution) => {
        const ref = Array.isArray(execution.output)
          ? execution.output[0]
          : undefined;
        assertExists(ref);
        const output = (await fixture.engine.content.resolver.get(ref, {
          namespace: "tenant-a",
        })).value as Record<string, unknown>;
        return [String(record(execution.tool).id), output] as const;
      })),
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

Deno.test("semantic graph and ready checkpoint roll back as one aggregate", async () => {
  const fixture = await createFixture(
    (request) =>
      response(request, [call(`memory-call-${request.messages.length}`, {
        outcome: "changes",
        assertions: [{
          localId: "atomic-state",
          kind: "assertion.state",
          summary: "Atomic memory must never become partially visible.",
          subject: { type: "external", id: "copilotz" },
          predicate: "commit_state",
          object: "atomic",
          epistemic: { basis: "observed", stance: "affirmed" },
          sources: [{ type: "message", id: "message-agent-a" }],
        }],
      })]),
    [],
    {
      validateCollection({ definition, record: value }) {
        if (
          definition.name === "long_term_memory" && value.status === "ready"
        ) {
          throw new Error("injected checkpoint settlement failure");
        }
      },
    },
  );
  try {
    await trigger(fixture);
    await waitForCheckpoint(fixture, "failed");
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    assertEquals(await scoped.memory_record.list({ limit: 100 }), []);
    assertEquals(
      (await fixture.engine.relations.list({
        namespace: "tenant-a",
        types: ["has_memory_record", "includes_memory_record"],
        limit: 100,
      })).filter((relation) =>
        relation.source.type === "memory_record" ||
        relation.target.type === "memory_record"
      ),
      [],
    );
    assertEquals(
      (await fixture.engine.events.list({
        namespace: "tenant-a",
        threadId: "thread-a",
        limit: 1_000,
      })).some((event) => event.type === "memory.consolidation.committed"),
      false,
    );
  } finally {
    await close(fixture);
  }
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
