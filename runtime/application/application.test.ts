import { assert, assertEquals, assertExists } from "@std/assert";

import type { TestDatabase } from "../testing/ominipg.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { createCopilotzApplication } from "./application.ts";
import { createCopilotz } from "./copilotz.ts";
import { createCopilotzCorePlugins } from "./core-plugins.ts";
import type { WorkflowTool } from "../workflows/index.ts";

const SCHEMA = "copilotz_application";
const NAMESPACE = "tenant-a";

function replyPlugin(): CopilotzPlugin {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "application.reply",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.routing?.senderId === "user-a",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const incoming = await context.conversation.getMessage(
        event.subject.id,
      );
      assertExists(incoming);
      const content = await context.content.prepare(
        { type: "text", text: "application reply" },
        { operationKey: "reply-content" },
      );
      await context.conversation.createMessage({
        id: `reply:${incoming.id}`,
        threadId: incoming.threadId,
        sender: {
          id: "agent-a",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
          name: "Support",
        },
        recipientIds: [incoming.sender.id],
        content,
      }, { operationKey: "reply-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "test.application.reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function closeDb(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("application factory composes plugins and supplies the default tenant scope", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    core: false,
    plugins: [replyPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    assert(Object.isFrozen(application));
    assertEquals(application.config, {
      namespace: NAMESPACE,
      databaseSchema: SCHEMA,
      corePluginIds: [],
      declaredPluginIds: ["test.application.reply"],
      databaseOwnership: "injected",
    });
    await application.conversation.createThread({
      namespace: NAMESPACE,
      id: "thread-a",
      participants: [
        {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        {
          id: "agent-a",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
      ],
    });
    const run = await application.run({
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
      content: "hello",
    });
    const observed = collect(run.events);
    await run.done;
    assertEquals(
      (await observed).filter((event) => event.type === "message.created")
        .length,
      2,
    );
    const messages = await application.conversation.listMessages(
      NAMESPACE,
      "thread-a",
    );
    assertEquals(messages.length, 2);
    const reply = await application.content.resolver.getMany(
      messages[1].content,
      { namespace: NAMESPACE },
    );
    assertEquals(reply[0].text, "application reply");

    await application.shutdown();
    await db.query("SELECT 1");
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("createCopilotz owns a configured Ominipg database", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: "public",
    core: false,
    database: { url: ":memory:" },
  });
  try {
    assertEquals(application.config.databaseOwnership, "application");
    const created = await application.conversation.createThread({
      namespace: NAMESPACE,
      id: "owned-database-thread",
      participants: [],
    });
    assertEquals(created.value?.id, "owned-database-thread");
  } finally {
    await application.shutdown();
    await application.shutdown();
  }
});

Deno.test("createCopilotz owns its default private database", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    core: false,
  });
  assertEquals(application.config.databaseOwnership, "application");
  await application.shutdown();
  await application.shutdown();
});

Deno.test("minimal built-ins precede explicit application resources", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const replacement = Object.freeze({
    id: "openai",
    type: "llm",
    marker: "application",
    factory: () => ({}),
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_core`,
    resources: { providers: [replacement] },
  });
  try {
    assertEquals(application.config.corePluginIds, [
      "@copilotz/built-in-llm-providers",
      "@copilotz/core-text",
    ]);
    assertEquals(
      application.plugins.require("providers", "openai"),
      replacement,
    );
    const agent: Agent | undefined = application.plugins.get(
      "agents",
      "missing",
    );
    assertEquals(agent, undefined);
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("knowledge is an explicit core-plugin opt-in", () => {
  assertEquals(
    createCopilotzCorePlugins({
      providers: false,
      tools: false,
      webTools: false,
      finance: false,
      memory: false,
      usage: false,
      text: false,
      ask: false,
      schedules: false,
      knowledge: { embedding: { provider: "fixture.embedding" } },
    }).map((plugin) => plugin.manifest.id),
    ["@copilotz/knowledge"],
  );
});

Deno.test("application exposes canonical effective capability introspection", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const tool: WorkflowTool = Object.freeze({
    id: "lookup",
    key: "lookup",
    name: "Lookup",
    description: "Looks up a fixture.",
    execute: () => ({ ok: true }),
  });
  const agent: Agent = Object.freeze({
    id: "support",
    name: "Support",
    role: "Support agent",
    capabilities: { tools: [tool.key] },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_capabilities`,
    core: false,
    resources: { agents: [agent], tools: [tool] },
  });
  try {
    const resolved = await application.capabilities.resolve({
      agent: agent.id,
    });
    assertEquals(resolved.agent, agent);
    assertEquals(resolved.tools.map((entry) => entry.id), [tool.key]);
    assertEquals(resolved.tools[0].origin?.pluginId, "@copilotz/application");
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("application never closes an injected database", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let closes = 0;
  const injected = Object.freeze({
    query: db.query,
    transaction: db.transaction,
    async close() {
      closes += 1;
      await db.close();
    },
  });
  const application = await createCopilotzApplication({
    database: injected,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_owned`,
    core: false,
  });
  await Promise.all([application.shutdown(), application.shutdown()]);
  assertEquals(closes, 0);
  assertEquals(application.config.databaseOwnership, "injected");
  await injected.query("SELECT 1");
  await injected.close();
  assertEquals(closes, 1);
});

Deno.test("application composition remains factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "application.ts",
      "core-plugins.ts",
      "index.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
  }
});
