import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../../runtime/engine/index.ts";
import {
  projectMessages,
  projectParticipantById,
  projectThreadById,
} from "../../core/testing/projections.ts";
import { createSqlSession } from "@copilotz/copilotz/events";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
  type ProcessorContext,
  type ProcessorEvent,
} from "@copilotz/copilotz/plugins";
import { BUILT_IN_CORE_TOOL_IDS, createBuiltInToolsPlugin } from "./plugin.ts";
import {
  type AgentResource,
  coreCollectionsPlugin,
  corePlugin,
} from "@copilotz/copilotz/core";
import type { ActionCallOptions } from "@copilotz/copilotz/actions";
import type { ToolResource } from "../contracts.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../runtime/testing/ominipg.ts";
import {
  createSkillsPlugin,
  defineInlineSkill,
} from "@copilotz/copilotz/skills";

const TEST_SCHEMA = "copilotz_core_tools";

const agent: AgentResource = {
  id: "agent-a",
  name: "Agent A",
  role: "assistant",
  models: {},
  instructions: "Exercise built-in tools.",
  capabilities: { skills: ["contract-skill"] },
};

const secondaryAgent: AgentResource = {
  id: "agent-b",
  name: "Agent B",
  role: "assistant",
  models: {},
  instructions: "Exercise atomic thread creation.",
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
    resources: {
      agents: { [agent.id]: agent, [secondaryAgent.id]: secondaryAgent },
    },
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

function actionOptions(
  context: ProcessorContext,
  sourceEvent: ProcessorEvent,
  id: string,
): ActionCallOptions {
  return {
    operationKey: `built-in-test:${id}`,
    identity: { correlationId: sourceEvent.correlationId },
    metadata: {
      threadId: "thread-a",
      agentId: agent.id,
      agentParticipantId: "agent-participant",
      initiatorParticipantId: "user-participant",
    },
  };
}

async function invoke(
  context: ProcessorContext,
  id: string,
  input: unknown,
  sourceEvent: ProcessorEvent,
): Promise<unknown> {
  const found = context.actions[id] as
    | ((input: unknown, options?: ActionCallOptions) => Promise<unknown>)
    | undefined;
  if (!found) throw new Error(`Unknown Action '${id}'.`);
  return await found(input, actionOptions(context, sourceEvent, id));
}

Deno.test("built-in tools exclude optional plugin-owned skill tools", () => {
  const plugin = createBuiltInToolsPlugin();
  const tools = plugin.resources.tools as
    | Readonly<Record<string, ToolResource>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), [...BUILT_IN_CORE_TOOL_IDS]);
  assertEquals(
    Object.values(tools ?? {}).map((value) => value.action),
    [...BUILT_IN_CORE_TOOL_IDS],
  );
  assertEquals(Object.keys(plugin.actions), [...BUILT_IN_CORE_TOOL_IDS]);
  assert(Object.values(tools ?? {}).every((value) => !("execute" in value)));
  assert(!Object.hasOwn(tools ?? {}, "load_skill"));
  assertThrows(
    () =>
      createBuiltInToolsPlugin({
        include: ["wait", "wait"],
      }),
    TypeError,
    "duplicate IDs",
  );
});

Deno.test("built-in tools compose beside Core without owning Core state", async () => {
  const builtIns = createBuiltInToolsPlugin({
    include: ["get_current_time"],
  });
  assertEquals(builtIns.plugins, []);
  const registry = await createPluginRegistry({
    plugins: [corePlugin, builtIns],
  });
  assertEquals(registry.collections.participant.name, "participant");
  const clock = registry.resources.tools.get_current_time as ToolResource;
  assertEquals(
    clock.action,
    "get_current_time",
  );
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
      const largeBody = new TextEncoder().encode(
        "large-asset-marker:".repeat(32_768),
      );
      const published = await processor.content.publish({
        mediaType: "text/plain",
        body: largeBody,
      }, { operationKey: "built-in-test:large-asset" });
      const saved = await invoke(
        processor,
        "save_asset",
        { assetId: published.id },
        sourceEvent,
      ) as Record<string, unknown>;
      const fetched = await invoke(
        processor,
        "fetch_asset",
        { assetId: saved.assetId },
        sourceEvent,
      ) as Record<string, unknown>;

      const listed = await invoke(
        processor,
        "list_skills",
        {},
        sourceEvent,
      ) as Record<string, unknown>;
      const loaded = await invoke(
        processor,
        "load_skill",
        { name: "contract-skill" },
        sourceEvent,
      ) as Record<string, unknown>;
      const resource = await invoke(
        processor,
        "read_skill_resource",
        { skill: "contract-skill", path: "references/guide.md" },
        sourceEvent,
      ) as Record<string, unknown>;
      await assertRejects(
        async () =>
          await invoke(
            processor,
            "read_skill_resource",
            { skill: "contract-skill", path: "../secret" },
            sourceEvent,
          ),
        TypeError,
      );
      const clock = await invoke(
        processor,
        "get_current_time",
        { format: "iso", timezone: "UTC" },
        sourceEvent,
      ) as Record<string, unknown>;
      const waited = await invoke(
        processor,
        "wait",
        { seconds: 0.25 },
        sourceEvent,
      );
      return { saved, fetched, listed, loaded, resource, clock, waited };
    });

    assertEquals(result.saved.mimeType, "text/plain");
    assertEquals(result.fetched.content, result.saved.content);
    assertEquals(result.listed.count, 1);
    assertEquals(result.loaded.content, "Follow the contract.");
    assertEquals(result.resource.content, "Contract guide");
    assertEquals(result.clock.iso, "2026-08-06T12:34:56.000Z");
    assertEquals(waits, [250]);

    const assets = await fixture.engine.events.list({ namespace: "tenant-a" });
    const assetEvent = assets.find((event) => event.type === "asset.created");
    assertExists(assetEvent);
    const durable = JSON.stringify(assets);
    assert(!durable.includes("large-asset-marker"));
    assert(!durable.includes("dataBase64"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("memory and thread tools mutate domain state idempotently", async () => {
  const fixture = await createFixture(createBuiltInToolsPlugin({
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  }));
  const childDeclaration = {
    id: "thread:separate-research",
    externalId: "separate-research",
    name: "Separate research",
    participants: [agent.id],
    initialMessage: "Investigate independently.",
    mode: "background",
    description: "A public child conversation",
    summary: "Independent research work",
    metadata: { purpose: "research" },
  } as const;
  try {
    const result = await fixture.run(async (processor, sourceEvent) => {
      await invoke(
        processor,
        "update_my_memory",
        { key: "architecture", value: "event-native", operation: "set" },
        sourceEvent,
      );
      const first = await invoke(
        processor,
        "update_user_memory",
        { content: "Prefers factory APIs", category: "preference" },
        sourceEvent,
      );
      const separate = await invoke(
        processor,
        "create_thread",
        childDeclaration,
        sourceEvent,
      );
      const separateReplay = await invoke(
        processor,
        "create_thread",
        childDeclaration,
        sourceEvent,
      );
      await invoke(
        processor,
        "end_thread",
        { summary: "Core tool migration complete" },
        sourceEvent,
      );
      return { first, separate, separateReplay };
    });
    assertEquals(result.separate, result.separateReplay);
    const recovered = await fixture.run(async (processor, sourceEvent) =>
      await invoke(processor, "create_thread", childDeclaration, sourceEvent)
    );
    assertEquals(recovered, result.separate);
    for (
      const mismatch of [
        { mode: "immediate" },
        { externalId: "different-external-id" },
        { description: "Different description" },
        { summary: "Different summary" },
        { metadata: { purpose: "different" } },
      ] as const
    ) {
      await assertRejects(
        () =>
          fixture.run(async (processor, sourceEvent) =>
            await invoke(processor, "create_thread", {
              ...childDeclaration,
              ...mismatch,
            }, sourceEvent)
          ),
        Error,
        "does not match the requested declaration",
      );
    }

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
    assert((items[0] as { id: string }).id.startsWith("memory:"));
    assertEquals(thread?.status, "archived");
    assertEquals(thread?.metadata.summary, "Core tool migration complete");
    const child = await projectThreadById(
      fixture.engine,
      "tenant-a",
      String((result.separate as { threadId: string }).threadId),
    );
    assertEquals(child?.parentThreadId, "thread-a");
    assertEquals(child?.metadata.name, "Separate research");
    assertEquals(child?.metadata.mode, "background");
    assertEquals(child?.externalId, "separate-research");
    assertEquals(child?.description, "A public child conversation");
    assertEquals(child?.metadata.summary, "Independent research work");
    assertEquals(child?.metadata.purpose, "research");
    assertEquals(child?.participants.map((item) => item.id), [
      "agent-participant",
    ]);
    const childMessages = await projectMessages(
      fixture.engine,
      "tenant-a",
      String((result.separate as { threadId: string }).threadId),
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

Deno.test("create_thread fails closed on an initial Message conflict without partial graph writes", async () => {
  const fixture = await createFixture();
  const namespace = "tenant-a";
  const threadId = "thread:atomic-conflict";
  const messageId = `message:${threadId}:initial`;
  try {
    const messages = fixture.engine.collections.get("message");
    const threads = fixture.engine.collections.get("thread");
    assertExists(messages);
    assertExists(threads);
    const conflictThreadId = "thread:conflict-holder";
    await threads.create({
      id: conflictThreadId,
      participantIds: ["user-participant"],
    }, { namespace });
    const content = await fixture.engine.content.preparer.prepare(
      "pre-existing conflict",
      { namespace, idempotencyKey: "atomic-conflict:content" },
    );
    await messages.create({
      id: messageId,
      threadId: conflictThreadId,
      senderId: "user-participant",
      recipientIds: [],
      content,
      metadata: {},
    }, {
      namespace,
      threadId: conflictThreadId,
      routing: { senderId: "user-participant", recipientIds: [] },
    });

    await assertRejects(
      () =>
        fixture.run(async (processor, sourceEvent) =>
          await invoke(processor, "create_thread", {
            id: threadId,
            name: "Must stay atomic",
            participants: [secondaryAgent.id],
            initialMessage: "This must not partially commit.",
          }, sourceEvent)
        ),
      Error,
      "inconsistent initial-message state",
    );
    assertEquals(
      await projectThreadById(fixture.engine, namespace, threadId),
      null,
    );
    assertEquals(
      await projectParticipantById(
        fixture.engine,
        namespace,
        `participant:${secondaryAgent.id}`,
      ),
      null,
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
