import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../../runtime/engine/index.ts";
import {
  projectMessages,
  projectParticipantById,
  projectThreadById,
} from "../../../runtime/testing/projections.ts";
import { createSqlSession } from "@copilotz/copilotz/events";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
  type ProcessorContext,
  type ProcessorEvent,
} from "@copilotz/copilotz/plugins";
import { coreCollectionsPlugin } from "@copilotz/copilotz/core";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import { BUILT_IN_CORE_TOOL_IDS, createBuiltInToolsPlugin } from "./plugin.ts";
import type { Agent } from "@copilotz/copilotz/resources";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../runtime/testing/ominipg.ts";
import {
  createSkillsPlugin,
  defineInlineSkill,
} from "@copilotz/copilotz/skills";

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

type RunAction<T> = (
  context: ProcessorContext,
  sourceEvent: ProcessorEvent,
) => Promise<T>;

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
  const runner = defineProcessor<ProcessorContext>({
    id: "test.core-tools.runner",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (event.threadId !== "thread-a") return;
      try {
        output = await active?.(context, event);
      } catch (error) {
        failure = error;
      }
    },
  });
  const app = definePlugin({
    id: "test.core-tools.resources",
    version: "1.0.0",
    processors: { runner },
    resources: { agents: { [agent.id]: agent } },
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
  const participants = engine.collections.get("participant");
  const threads = engine.collections.get("thread");
  const messages = engine.collections.get("message");
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
      const created = await messages.create({
        id: `trigger-${trigger}`,
        threadId: "thread-a",
        senderId: "user-participant",
        recipientIds: ["agent-participant"],
        content,
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
  context: ProcessorContext,
  sourceEvent: ProcessorEvent,
  id: string,
): Promise<WorkflowToolExecutionContext> {
  const execution = Object.freeze({
    id,
    namespace: context.namespace,
    threadId: "thread-a",
    participantId: "agent-participant",
    agentId: agent.id,
    toolCallId: `call:${id}`,
    tool: { id: "fixture", name: "Fixture" },
    metadata: {},
  });
  return {
    namespace: context.namespace,
    correlationId: sourceEvent.correlationId,
    idempotencyKey: context.operationKey,
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
    tools: Object.values(context.resources.tools ?? {}).filter(
      (value): value is WorkflowTool => !!value,
    ),
    collections: context.collections,
    emitOutput: () => Promise.resolve(),
    cancelled: false,
  };
}

function tool(
  context: ProcessorContext,
  id: string,
): WorkflowTool {
  const found = context.resources.tools?.[id];
  if (!found) throw new Error(`Unknown tool '${id}'.`);
  return found as WorkflowTool;
}

Deno.test("built-in tools exclude optional plugin-owned skill tools", () => {
  const plugin = createBuiltInToolsPlugin();
  const tools = plugin.resources.tools as
    | Readonly<Record<string, WorkflowTool>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), [...BUILT_IN_CORE_TOOL_IDS]);
  assertEquals(
    Object.values(tools ?? {}).map((value) => value.key),
    [...BUILT_IN_CORE_TOOL_IDS],
  );
  assert(!Object.hasOwn(tools ?? {}, "load_skill"));
});

Deno.test("asset, skill, clock, and wait tools use typed capabilities", async () => {
  const waits: number[] = [];
  const fixture = await createFixture(createBuiltInToolsPlugin({
    now: () => new Date("2026-08-06T12:34:56.000Z"),
    sleep(milliseconds) {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  }));
  try {
    const result = await fixture.run(async (processor, sourceEvent) => {
      const ctx = await toolContext(
        processor,
        sourceEvent,
        "execution-built-ins",
      );
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
      return { saved, fetched, listed, loaded, resource, clock, waited };
    });

    assertEquals(result.saved.mimeType, "text/plain");
    assertEquals(atob(String(result.fetched.base64)), "canonical body");
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
    const result = await fixture.run(async (processor, sourceEvent) => {
      const ctx = await toolContext(
        processor,
        sourceEvent,
        "execution-memory",
      );
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
  for (const module of ["plugin.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/\bclass\s+\w+/.test(source));
    assert(!/unsafeGraph|\.db\b|queueId|ResourceManifest/.test(source));
  }
});
