import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import type { Agent } from "../resources/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  type CopilotzEngine,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAPI,
  TokenUsage,
} from "../llm/types.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
} from "../plugins/index.ts";
import { createLongTermMemoryPlugin } from "./plugin.ts";
import type { MemoryConsolidator } from "./types.ts";
import {
  createTextWorkflowPlugin,
  defineLlmProviderResource,
  type LlmChat,
} from "../workflows/index.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../workflows/index.ts";

const agent: Agent = {
  id: "north",
  name: "north",
  role: "assistant",
  instructions: "You are north.",
  llmOptions: { provider: "openai", model: "contract-model" },
};

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  registry: PluginRegistry;
}>;

async function createFixture(
  consolidate: MemoryConsolidator,
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const resources = definePlugin({
    manifest: {
      id: "test.memory.resources",
      version: "1.0.0",
      provides: { agents: [agent.id] },
    },
    resources: { agents: [agent] },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createLongTermMemoryPlugin({
        config: {
          triggerEstimatedTokens: 8,
          maxContentEstimatedTokens: 2_000,
          retrievalLimit: 10,
        },
        consolidate,
        embed: (texts) =>
          Promise.resolve(texts.map((text) => [text.length, 1])),
      }),
      resources,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "memory_plugin_contract",
    retryBaseMs: 0,
    random: () => 0,
  });
  return Object.freeze({ db, engine, registry });
}

async function createConversation(fixture: Fixture): Promise<void> {
  await fixture.engine.conversation.createThread({
    namespace: "tenant-a",
    id: "thread-a",
    participants: [
      {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      {
        id: "agent-north",
        externalId: agent.id,
        participantType: "agent",
        agentId: agent.id,
      },
    ],
    identity: { deduplicationId: "thread-a:create" },
  });
}

async function addMessage(
  fixture: Fixture,
  input: Readonly<{
    id: string;
    sender: "user" | "agent";
    text: string;
  }>,
) {
  const participant = input.sender === "user"
    ? {
      id: "user-a",
      externalId: "user-a",
      participantType: "human" as const,
    }
    : {
      id: "agent-north",
      externalId: agent.id,
      participantType: "agent" as const,
      agentId: agent.id,
    };
  const content = await fixture.engine.content.preparer.prepare(input.text, {
    namespace: "tenant-a",
    idempotencyKey: `${input.id}:content`,
  });
  return await fixture.engine.conversation.createMessage({
    namespace: "tenant-a",
    id: input.id,
    threadId: "thread-a",
    sender: participant,
    content,
    identity: {
      correlationId: `correlation:${input.id}`,
      deduplicationId: `${input.id}:create`,
    },
  });
}

Deno.test("memory plugin exposes tenant-scoped knowledge spaces through a typed tool", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let output: unknown;
  const runner = defineProcessor<CopilotzProcessorContext>({
    id: "test.memory.list-spaces",
    on: ["fixture.memory-spaces.requested"],
    delivery: "durable",
    async handle(_event, context) {
      const tool = context.resources.require<WorkflowTool>(
        "tools",
        "list_knowledge_spaces",
      );
      output = await tool.execute!({ limit: 10 }, {
        processor: context,
      } as WorkflowToolExecutionContext);
    },
  });
  const runnerPlugin = definePlugin({
    manifest: {
      id: "test.memory-space-tool-runner",
      version: "1.0.0",
      provides: { processors: [runner.id] },
    },
    resources: { processors: [runner] },
  });
  const memory = createLongTermMemoryPlugin({ enabled: false });
  const registry = await createPluginRegistry({
    plugins: [memory, runnerPlugin],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "memory_space_tool_contract",
  });
  try {
    assertEquals(memory.manifest.provides.tools, ["list_knowledge_spaces"]);
    const collections = engine.collections.withScope({
      namespace: "tenant-a",
    });
    await collections.memory_space.create({
      id: "memory-space-a",
      name: "Shared support memory",
      scopeType: "team",
      scopeId: "support",
      kind: "knowledge",
      description: "Facts shared by support agents",
      metadata: { tier: "shared" },
    });
    const requested = await engine.events.append({
      type: "fixture.memory-spaces.requested",
      namespace: "tenant-a",
      payload: {},
    });
    await Promise.all(requested.dispatch.handles.map((handle) => handle.done));
    assertEquals(output, {
      knowledgeSpaces: [{
        id: "memory-space-a",
        name: "Shared support memory",
        scopeType: "team",
        scopeId: "support",
        kind: "knowledge",
        description: "Facts shared by support agents",
        metadata: { tier: "shared" },
        createdAt: (output as {
          knowledgeSpaces: Array<{ createdAt: string }>;
        }).knowledgeSpaces[0].createdAt,
        updatedAt: (output as {
          knowledgeSpaces: Array<{ updatedAt: string }>;
        }).knowledgeSpaces[0].updatedAt,
      }],
      totalKnowledgeSpaces: 1,
    });
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

async function waitForReadyCheckpoint(
  fixture: Fixture,
  rootEventId: string,
): Promise<Record<string, unknown>> {
  const scoped = fixture.engine.collections.withScope({
    namespace: "tenant-a",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const values = await scoped.long_term_memory.list({
      where: { threadId: "thread-a", agentId: agent.id },
      limit: 100,
    });
    const ready = values.find((value) => value.status === "ready");
    if (ready) return ready;
    const settlement = await fixture.engine.events.settlement(
      "tenant-a",
      rootEventId,
    );
    if (settlement.deadLetters > 0) {
      const deliveries = await fixture.engine.deliveries.list({
        namespace: "tenant-a",
        status: "dead_letter",
      });
      throw new Error(`Memory dead-lettered: ${JSON.stringify(deliveries)}`);
    }
    await fixture.engine.recover({ namespace: "tenant-a", limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a ready memory checkpoint.");
}

async function checkpointText(
  fixture: Fixture,
  checkpoint: Record<string, unknown>,
): Promise<string> {
  const refs = checkpoint.content;
  assert(Array.isArray(refs));
  const resolved = await fixture.engine.content.resolver.getMany(
    refs,
    { namespace: "tenant-a" },
  );
  return resolved.map((item) => item.text ?? "").join("\n");
}

Deno.test("long-term memory reserves, consolidates, and settles ready last", async () => {
  const calls: string[][] = [];
  const consolidate: MemoryConsolidator = (input) => {
    calls.push(input.sourceMessages.map((message) => message.id));
    const sourceId = input.sourceMessages.at(-1)!.id;
    const defaultSpace = input.spaces.find((space) => space.defaultWrite)!;
    return Promise.resolve({
      proposal: {
        continuityPatch: {
          state: {
            currentState: {
              value: "The event-native migration is active.",
              sourceMessageIds: [sourceId],
            },
          },
        },
        nodes: [{
          localId: "copilotz-entity",
          kind: "entity",
          name: "Copilotz",
          content: "Copilotz is the framework being migrated.",
          confidence: 1,
          sourceMessageIds: [sourceId],
          memorySpaceId: defaultSpace.id,
        }, {
          localId: "migration-decision",
          kind: "decision",
          name: "Use event-native memory",
          content: "Long-term memory uses durable plugin processors.",
          confidence: 0.95,
          sourceMessageIds: [sourceId],
          memorySpaceId: defaultSpace.id,
        }],
        relations: [{
          source: "migration-decision",
          type: "mentions",
          target: "copilotz-entity",
        }],
      },
    });
  };
  const fixture = await createFixture(consolidate);
  try {
    await createConversation(fixture);
    await addMessage(fixture, {
      id: "message-user",
      sender: "user",
      text: "Please preserve the event-native architecture decision for later.",
    });
    const root = await addMessage(fixture, {
      id: "message-agent",
      sender: "agent",
      text: "I will preserve this architecture decision in durable memory.",
    });
    const checkpoint = await waitForReadyCheckpoint(fixture, root.event.id);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].at(-1), "message-agent");
    assertEquals(checkpoint.status, "ready");
    assertEquals(checkpoint.sequence, 1);
    assert(Array.isArray(checkpoint.content));
    assertEquals(typeof checkpoint.contentHash, "string");
    const text = await checkpointText(fixture, checkpoint);
    assertStringIncludes(text, "## LONG-TERM CONVERSATION MEMORY");
    assertStringIncludes(text, "The event-native migration is active.");
    assertStringIncludes(
      text,
      "Long-term memory uses durable plugin processors.",
    );

    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    const spaces = await scoped.memory_space.list({ limit: 100 });
    const access = await scoped.memory_space_access.list({
      where: { threadId: "thread-a" },
      limit: 100,
    });
    const nodes = await scoped.brain_node.list({
      where: { checkpointId: checkpoint.id },
      limit: 100,
    });
    assertEquals(spaces.length, 1);
    assertEquals(access.length, 1);
    assertEquals(access[0].access, "read_write");
    assertEquals(access[0].defaultWrite, true);
    assertEquals(
      nodes.filter((node) => node.layer === "knowledge").length,
      2,
    );
    assert(
      nodes.some((node) =>
        node.layer === "working" && node.kind === "current_state"
      ),
    );
    assertEquals(
      new Set(nodes.map((node) => node.id)).size,
      nodes.length,
    );
    const relations = await fixture.engine.relations.list({
      namespace: "tenant-a",
      types: ["mentions"],
    });
    assertEquals(relations.length, 1);
    assertEquals(relations[0].metadata.checkpointId, checkpoint.id);

    const attempts = await fixture.engine.llmAttempts.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0].status, "completed");
    assertEquals(attempts[0].metadata.memoryCheckpointId, checkpoint.id);
    assertExists(attempts[0].finishedAt);
  } finally {
    await fixture.engine.shutdown();
    await fixture.db.close();
  }
});

Deno.test("memory spaces remain shareable through independent thread grants", async () => {
  const consolidate: MemoryConsolidator = (input) => {
    const sourceId = input.sourceMessages.at(-1)!.id;
    const shared = input.spaces.find((space) => space.id === "shared-space")!;
    return Promise.resolve({
      proposal: {
        continuityPatch: {},
        nodes: [{
          localId: "shared-fact",
          kind: "fact",
          name: "Shared preference",
          content: "The user prefers shared memory spaces.",
          sourceMessageIds: [sourceId],
          memorySpaceId: shared.id,
        }],
        relations: [],
      },
    });
  };
  const fixture = await createFixture(consolidate);
  try {
    await createConversation(fixture);
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    await scoped.memory_space.create({
      id: "shared-space",
      name: "Shared user memory",
      scopeType: "user",
      scopeId: "user-a",
      kind: "user",
      ownerNodeId: "user-a",
      description: "Cross-thread user memory",
      metadata: {},
    });
    await scoped.memory_space_access.create({
      id: "grant:thread-a:shared",
      threadId: "thread-a",
      memorySpaceId: "shared-space",
      access: "read_write",
      defaultWrite: true,
      metadata: {},
    });
    await addMessage(fixture, {
      id: "shared-user",
      sender: "user",
      text: "Remember this preference in shared memory across conversations.",
    });
    const root = await addMessage(fixture, {
      id: "shared-agent",
      sender: "agent",
      text: "I will retain the cross-thread shared preference.",
    });
    const checkpoint = await waitForReadyCheckpoint(fixture, root.event.id);
    assertEquals(checkpoint.defaultWriteMemorySpaceId, "shared-space");
    const nodes = await scoped.brain_node.list({
      where: { checkpointId: checkpoint.id, layer: "knowledge" },
      limit: 100,
    });
    assertEquals(nodes.length, 1);
    assertEquals(nodes[0].memorySpaceId, "shared-space");
    assertEquals((await scoped.memory_space.list({ limit: 100 })).length, 1);
  } finally {
    await fixture.engine.shutdown();
    await fixture.db.close();
  }
});

Deno.test("consolidation retries reuse checkpoint identity without duplicate brain nodes", async () => {
  let calls = 0;
  const consolidate: MemoryConsolidator = (input) => {
    calls++;
    if (calls === 1) throw new Error("synthetic transient failure");
    const sourceId = input.sourceMessages.at(-1)!.id;
    const space = input.spaces.find((candidate) => candidate.defaultWrite)!;
    return Promise.resolve({
      proposal: {
        continuityPatch: {},
        nodes: [{
          localId: "retry-safe-node",
          kind: "fact",
          name: "Retry safe",
          content: "Checkpoint retries preserve one stable brain node.",
          sourceMessageIds: [sourceId],
          memorySpaceId: space.id,
        }],
        relations: [],
      },
    });
  };
  const fixture = await createFixture(consolidate);
  try {
    await createConversation(fixture);
    await addMessage(fixture, {
      id: "retry-user",
      sender: "user",
      text: "Preserve this retry-safe checkpoint behavior in memory.",
    });
    const root = await addMessage(fixture, {
      id: "retry-agent",
      sender: "agent",
      text: "The checkpoint will retry without duplicating records.",
    });
    const checkpoint = await waitForReadyCheckpoint(fixture, root.event.id);
    assertEquals(calls, 2);
    const scoped = fixture.engine.collections.withScope({
      namespace: "tenant-a",
    });
    const checkpoints = await scoped.long_term_memory.list({
      where: { threadId: "thread-a", agentId: agent.id },
      limit: 100,
    });
    const nodes = await scoped.brain_node.list({
      where: { checkpointId: checkpoint.id, layer: "knowledge" },
      limit: 100,
    });
    assertEquals(checkpoints.length, 1);
    assertEquals(nodes.length, 1);
    assertEquals(
      nodes[0].id,
      `${checkpoint.id}:brain:retry-safe-node`,
    );
    const attempts = await fixture.engine.llmAttempts.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(attempts.map((attempt) => attempt.status), [
      "failed",
      "completed",
    ]);
  } finally {
    await fixture.engine.shutdown();
    await fixture.db.close();
  }
});

Deno.test("ready memory contributes to the text prompt and replaces archived history", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const prompts: ChatRequest[] = [];
  const usage: TokenUsage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    source: "provider",
    status: "completed",
  };
  const chat: LlmChat = (request): Promise<ChatResponse> => {
    prompts.push(request);
    return Promise.resolve({
      prompt: request.messages,
      answer: prompts.length === 1
        ? "FIRST_AGENT_RAW_MARKER"
        : "SECOND_AGENT_RESPONSE",
      tokens: 2,
      usage,
      provider: "openai",
      model: "contract-model",
      finishReason: "stop",
    });
  };
  const consolidate: MemoryConsolidator = (input) => {
    const sourceId = input.sourceMessages.at(-1)!.id;
    return Promise.resolve({
      proposal: {
        continuityPatch: {
          state: {
            currentState: {
              value: "DURABLE_CHECKPOINT_MARKER",
              sourceMessageIds: [sourceId],
            },
          },
        },
        nodes: [],
        relations: [],
      },
    });
  };
  const provider = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    factory: () => ({}) as ProviderAPI,
  });
  const resources = definePlugin({
    manifest: {
      id: "test.memory-prompt.resources",
      version: "1.0.0",
      provides: { agents: [agent.id], providers: [provider.id] },
    },
    resources: { agents: [agent], providers: [provider] },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createLongTermMemoryPlugin({
        config: { triggerEstimatedTokens: 1 },
        consolidate,
      }),
      createTextWorkflowPlugin({ chat }),
      resources,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "memory_prompt_contract",
    retryBaseMs: 0,
    random: () => 0,
  });
  const fixture = { db, engine, registry } as Fixture;
  try {
    await createConversation(fixture);
    const send = async (id: string, text: string) => {
      const content = await engine.content.preparer.prepare(text, {
        namespace: "tenant-a",
        idempotencyKey: `${id}:content`,
      });
      return await engine.conversation.createMessage({
        namespace: "tenant-a",
        id,
        threadId: "thread-a",
        sender: {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        recipientIds: ["agent-north"],
        content,
        identity: {
          correlationId: `correlation:${id}`,
          deduplicationId: `${id}:create`,
        },
      });
    };
    const first = await send(
      "prompt-user-1",
      "ARCHIVED_RAW_MARKER should leave the active transcript.",
    );
    await waitForReadyCheckpoint(fixture, first.event.id);
    assertEquals(prompts.length, 1);

    const second = await send(
      "prompt-user-2",
      "CURRENT_INPUT_MARKER must remain in the active transcript.",
    );
    const deadline = Date.now() + 10_000;
    while (prompts.length < 2 && Date.now() < deadline) {
      const settlement = await engine.events.settlement(
        "tenant-a",
        second.event.id,
      );
      if (settlement.deadLetters) {
        throw new Error("Second memory-backed text run dead-lettered.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(prompts.length >= 2, true);
    const prompt = JSON.stringify(prompts[1].messages);
    assertStringIncludes(prompt, "DURABLE_CHECKPOINT_MARKER");
    assertStringIncludes(prompt, "CURRENT_INPUT_MARKER");
    assertEquals(prompt.includes("ARCHIVED_RAW_MARKER"), false);
    assertEquals(prompt.includes("FIRST_AGENT_RAW_MARKER"), false);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
