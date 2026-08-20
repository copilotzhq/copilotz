import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type CopilotzEngine,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "../engine/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipantById,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";
import { createSqlSession } from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
} from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { loadToolExecutionRecord } from "../engine/collection-graph.ts";
import type { WorkflowTool, WorkflowToolExecutionContext } from "./types.ts";
import {
  BUILT_IN_CORE_TOOL_IDS,
  createBuiltInToolsPlugin,
} from "./core-plugin.ts";
import type { Agent } from "../resources/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createSkillsPlugin, defineInlineSkill } from "../skills/index.ts";

const TEST_SCHEMA = "copilotz_core_tools";

const agent: Agent = {
  id: "agent-a",
  name: "Agent A",
  role: "assistant",
  instructions: "Exercise built-in tools.",
  capabilities: { skills: ["contract-skill"] },
};

const skill = defineInlineSkill({
  directoryName: "contract-skill",
  markdown: `---
name: contract-skill
description: Contract skill used by the built-in tool integration test.
---
Follow the contract.`,
  files: { "references/guide.md": "Contract guide" },
});

type RunAction<T> = (context: CopilotzProcessorContext) => Promise<T>;

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  registry: PluginRegistry;
  run<T>(action: RunAction<T>): Promise<T>;
}>;

async function createFixture(
  builtIns = createBuiltInToolsPlugin(),
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  let active: RunAction<unknown> | undefined;
  let output: unknown;
  let failure: unknown;
  const runner = defineProcessor<CopilotzProcessorContext>({
    id: "test.core-tools.runner",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (event.threadId !== "thread-a") return;
      try {
        output = await active?.(context);
      } catch (error) {
        failure = error;
      }
    },
  });
  const app = definePlugin({
    manifest: {
      id: "test.core-tools.resources",
      version: "1.0.0",
      provides: {
        agents: [agent.id],
        processors: [runner.id],
      },
    },
    resources: { agents: [agent], processors: [runner] },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      builtIns,
      createSkillsPlugin({
        id: "test.core-tools.skills",
        version: "1.0.0",
        skills: [skill],
      }),
      app,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    defaultDatabaseSchema: TEST_SCHEMA,
    registry,
    retryBaseMs: 0,
    random: () => 0,
  });
  const namespace = "tenant-a";
  const participants = engine.collectionRuntime.get("participant");
  const threads = engine.collectionRuntime.get("thread");
  const messages = engine.collectionRuntime.get("message");
  if (!participants || !threads || !messages) {
    throw new Error("Core collections are not bound.");
  }
  await participants.create({
    id: "user-participant",
    externalId: "user-a",
    participantType: "human",
    metadata: { profile: true },
  }, { namespace });
  await participants.create({
    id: "agent-participant",
    externalId: "agent-a",
    participantType: "agent",
    agentId: "agent-a",
    metadata: { retained: true },
  }, { namespace });
  await threads.create({
    id: "thread-a",
    participantIds: ["user-participant", "agent-participant"],
  }, { namespace });
  let trigger = 0;
  return Object.freeze({
    db,
    engine,
    registry,
    async run<T>(action: RunAction<T>): Promise<T> {
      active = action as RunAction<unknown>;
      output = undefined;
      failure = undefined;
      const content = await engine.content.preparer.prepare(
        `trigger-${++trigger}`,
        { namespace, idempotencyKey: `trigger:${trigger}` },
      );
      for (const asset of content.assets) {
        if (await engine.content.assets.get(asset.namespace, asset.id)) {
          continue;
        }
        await engine.content.assets.publish({
          namespace: asset.namespace,
          id: asset.id,
          mediaType: asset.mediaType,
          body: asset.body,
          ...(asset.idempotencyKey
            ? { idempotencyKey: asset.idempotencyKey }
            : {}),
          ...(asset.origin ? { origin: asset.origin } : {}),
          ...(asset.metadata ? { metadata: { ...asset.metadata } } : {}),
        });
      }
      const created = await messages.create({
        id: `trigger-${trigger}`,
        threadId: "thread-a",
        senderId: "user-participant",
        recipientIds: ["agent-participant"],
        content: content.content,
        metadata: {},
      }, {
        namespace,
        threadId: "thread-a",
        routing: {
          senderId: "user-participant",
          recipientIds: ["agent-participant"],
        },
      });
      await Promise.all(created.dispatch.handles.map((handle) => handle.done));
      active = undefined;
      if (failure) throw failure;
      return output as T;
    },
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function toolContext(
  context: CopilotzProcessorContext,
  id: string,
): Promise<WorkflowToolExecutionContext> {
  const argumentsContent = await context.content.prepare({
    type: "json",
    role: "tool.arguments",
    value: {},
  }, { operationKey: `fixture:${id}:arguments` });
  const created = await context.features.toolExecution.create({
    id,
    threadId: "thread-a",
    participantId: "agent-participant",
    agentId: agent.id,
    toolCallId: `call:${id}`,
    tool: { id: "fixture", name: "Fixture" },
    status: "running",
    arguments: argumentsContent,
  }, { operationKey: `fixture:${id}:create` }) as { id: string };
  const execution = await loadToolExecutionRecord(context, created.id);
  assertExists(execution);
  return {
    namespace: context.namespace,
    correlationId: context.event.correlationId ?? context.event.id,
    idempotencyKey: context.idempotencyKey,
    execution,
    processor: context,
    threadId: "thread-a",
    toolExecutionId: id,
    toolCallId: `call:${id}`,
    senderId: agent.id,
    senderType: "agent",
    userExternalId: "user-a",
    agent,
    agents: [agent],
    tools: [...context.resources.list<WorkflowTool>("tools")],
    collections: context.collections,
    emitOutput: () => Promise.resolve(),
    cancelled: false,
  };
}

function tool(
  context: CopilotzProcessorContext,
  id: string,
): WorkflowTool {
  return context.resources.require<WorkflowTool>("tools", id);
}

Deno.test("built-in tools exclude optional plugin-owned skill tools", () => {
  const plugin = createBuiltInToolsPlugin();
  assertEquals(plugin.manifest.provides.tools, [...BUILT_IN_CORE_TOOL_IDS]);
  assertEquals(
    plugin.resources.tools?.map((value) => (value as WorkflowTool).key),
    [...BUILT_IN_CORE_TOOL_IDS],
  );
  assert(!plugin.manifest.provides.tools?.includes("load_skill"));
});

Deno.test("asset, result, skill, clock, and wait tools use typed capabilities", async () => {
  const waits: number[] = [];
  const fixture = await createFixture(createBuiltInToolsPlugin({
    now: () => new Date("2026-08-06T12:34:56.000Z"),
    sleep(milliseconds) {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  }));
  try {
    const result = await fixture.run(async (processor) => {
      const ctx = await toolContext(processor, "execution-built-ins");
      const saved = await tool(processor, "save_asset").execute!(
        {
          mimeType: "text/plain",
          dataBase64: btoa("canonical body"),
        },
        ctx,
      ) as Record<string, unknown>;
      const fetched = await tool(processor, "fetch_asset").execute!(
        { assetId: saved.assetId, format: "base64" },
        ctx,
      ) as Record<string, unknown>;

      const targetArguments = await processor.content.prepare({
        type: "json",
        role: "tool.arguments",
        value: {},
      }, { operationKey: "target:arguments" });
      await processor.features.toolExecution.create({
        id: "target-execution",
        threadId: "thread-a",
        participantId: "agent-participant",
        agentId: agent.id,
        toolCallId: "target-call",
        tool: { id: "target", name: "Target" },
        status: "running",
        arguments: targetArguments,
      }, { operationKey: "target:create" });
      const targetOutput = await processor.content.prepare({
        type: "json",
        role: "tool.output",
        value: { text: "needle", large: "x".repeat(100) },
      }, { operationKey: "target:output" });
      const materializedOutput = await processor.content.materialize(
        targetOutput,
        {
          origin: {
            scope: { type: "thread", id: "thread-a" },
            producer: { type: "tool_execution", id: "target-execution" },
          },
        },
      );
      const targetExecution = await processor.collections.tool_execution.get({
        id: "target-execution",
      });
      assertExists(targetExecution);
      const existingContent = Array.isArray(targetExecution.content)
        ? targetExecution.content
        : [];
      await processor.collections.tool_execution.commands.complete({
        id: "target-execution",
        content: [...existingContent, ...materializedOutput],
        finishedAt: new Date().toISOString(),
      }, { operationKey: "target:complete", threadId: "thread-a" });
      if (materializedOutput.length) {
        await processor.content.linkOwner(
          "target-execution",
          materializedOutput,
        );
      }
      const read = await tool(processor, "read_tool_result").execute!(
        { toolExecutionId: "target-execution", regex: "needle", limit: 40 },
        ctx,
      ) as Record<string, unknown>;
      const listed = await tool(processor, "list_skills").execute!(
        {},
        ctx,
      ) as Record<string, unknown>;
      const loaded = await tool(processor, "load_skill").execute!(
        { name: "contract-skill" },
        ctx,
      ) as Record<string, unknown>;
      const resource = await tool(processor, "read_skill_resource").execute!(
        { skill: "contract-skill", path: "references/guide.md" },
        ctx,
      ) as Record<string, unknown>;
      await assertRejects(
        async () =>
          await tool(processor, "read_skill_resource").execute!(
            { skill: "contract-skill", path: "../secret" },
            ctx,
          ),
        TypeError,
      );
      const clock = await tool(processor, "get_current_time").execute!(
        { format: "iso", timezone: "UTC" },
        ctx,
      ) as Record<string, unknown>;
      const waited = await tool(processor, "wait").execute!(
        { seconds: 0.25 },
        ctx,
      );
      return { saved, fetched, read, listed, loaded, resource, clock, waited };
    });

    assertEquals(result.saved.mimeType, "text/plain");
    assertEquals(atob(String(result.fetched.base64)), "canonical body");
    assertEquals(result.read.matchFound, true);
    assert(String(result.read.excerpt).includes("needle"));
    assertEquals(result.listed.count, 1);
    assertEquals(result.loaded.content, "Follow the contract.");
    assertEquals(result.resource.content, "Contract guide");
    assertEquals(result.clock.iso, "2026-08-06T12:34:56.000Z");
    assertEquals(waits, [250]);

    const assets = await fixture.engine.events.list({ namespace: "tenant-a" });
    const assetEvent = assets.find((event) => event.type === "asset.created");
    assertExists(assetEvent);
    assert(!JSON.stringify(assetEvent).includes("canonical body"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("memory and thread tools mutate domain state idempotently", async () => {
  const fixture = await createFixture(createBuiltInToolsPlugin({
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  }));
  try {
    const result = await fixture.run(async (processor) => {
      const ctx = await toolContext(processor, "execution-memory");
      await tool(processor, "update_my_memory").execute!(
        { key: "architecture", value: "event-native", operation: "set" },
        ctx,
      );
      const first = await tool(processor, "update_user_memory").execute!(
        { content: "Prefers factory APIs", category: "preference" },
        ctx,
      );
      const replay = await tool(processor, "update_user_memory").execute!(
        { content: "Prefers factory APIs", category: "preference" },
        ctx,
      );
      const separate = await tool(processor, "create_thread").execute!(
        {
          name: "Separate research",
          participants: [agent.id],
          initialMessage: "Investigate independently.",
          mode: "background",
          description: "A public child conversation",
        },
        ctx,
      );
      const separateReplay = await tool(processor, "create_thread").execute!(
        {
          name: "Separate research",
          participants: [agent.id],
          initialMessage: "Investigate independently.",
          mode: "background",
          description: "A public child conversation",
        },
        ctx,
      );
      await tool(processor, "end_thread").execute!(
        { summary: "Core tool migration complete" },
        ctx,
      );
      return { first, replay, separate, separateReplay };
    });
    assertEquals(result.separate, result.separateReplay);

    const agentParticipant = await projectParticipantById(
      fixture.engine,
      "tenant-a",
      "agent-participant",
    );
    const userParticipant = await projectParticipantById(
      fixture.engine,
      "tenant-a",
      "user-participant",
    );
    const thread = await projectThreadById(
      fixture.engine,
      "tenant-a",
      "thread-a",
    );
    assertEquals(agentParticipant?.metadata, {
      retained: true,
      architecture: "event-native",
    });
    const items = (userParticipant?.metadata.memories as {
      items: unknown[];
    }).items;
    assertEquals(items.length, 1);
    assertEquals((items[0] as { id: string }).id, "memory:execution-memory");
    assertEquals(thread?.status, "archived");
    assertEquals(thread?.metadata.summary, "Core tool migration complete");
    const child = await projectThreadById(
      fixture.engine,
      "tenant-a",
      "thread:execution-memory",
    );
    assertEquals(child?.parentThreadId, "thread-a");
    assertEquals(child?.metadata.name, "Separate research");
    assertEquals(child?.metadata.mode, "background");
    assertEquals(child?.participants.map((item) => item.id), [
      "agent-participant",
    ]);
    const childMessages = await projectMessages(
      fixture.engine,
      "tenant-a",
      "thread:execution-memory",
    );
    assertEquals(childMessages.length, 1);
    assertEquals(
      await fixture.engine.content.resolver.getMany(childMessages[0].content, {
        namespace: "tenant-a",
      }).then((parts) => parts[0].text),
      "Investigate independently.",
    );

    const events = await fixture.engine.events.list({ namespace: "tenant-a" });
    assertEquals(
      events.filter((event) => event.type === "participant.updated").length,
      2,
    );
    assertEquals(
      events.filter((event) => event.type === "thread.updated").length,
      1,
    );
    assertEquals(
      events.filter((event) => event.type === "thread.created").length,
      2,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 built-in tool core stays factory-first and runtime-neutral", async () => {
  for (const module of ["core-plugin.ts", "index.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/\bclass\s+\w+/.test(source));
    assert(!/unsafeGraph|\.db\b|queueId|ResourceManifest/.test(source));
  }
});
