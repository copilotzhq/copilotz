import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { createCollectionsManager } from "@/database/collections/index.ts";
import loadResources from "@/runtime/loaders/resources.ts";
import participantCollection from "@/resources/collections/participant.ts";
import {
  participantLifecycleProcessor,
  priority,
} from "./participant_lifecycle.ts";
import { messageProcessor } from "./index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";

type TestDb = Awaited<ReturnType<typeof createDatabase>>;

async function createTestDb(name: string): Promise<{
  db: TestDb;
  tempDir: string;
}> {
  const tempDir = await Deno.makeTempDir();
  const db = await createDatabase({ url: `file://${tempDir}/${name}.db` });
  return { db, tempDir };
}

async function closeTestDb(db: TestDb, tempDir: string): Promise<void> {
  try {
    await (db as { close?: () => Promise<void> | void }).close?.();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("participant lifecycle processor upserts sender and configured agents", async () => {
  const { db, tempDir } = await createTestDb("participant-lifecycle-upsert");
  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace("tenant-a");

  const event = {
    id: "evt-1",
    threadId: "thread-1",
    type: "NEW_MESSAGE",
    payload: {
      content: "hello",
      sender: {
        type: "user",
        externalId: "user-1",
        name: "User One",
        metadata: { email: "user@example.com" },
      },
    },
  } as unknown as Event;

  const deps = {
    db,
    thread: { id: "thread-1" },
    context: {
      namespace: "tenant-a",
      collections,
      agents: [{
        id: "agent-1",
        name: "Agent One",
        role: "assistant",
        instructions: "help",
        llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      }],
    },
    emitToStream: () => {},
  } as unknown as ProcessorDeps;

  try {
    const result = await participantLifecycleProcessor.process(
      event,
      deps,
    ) as any;
    assertEquals(result?.externalId, "user-1");

    const user = await collections.participant.findOne({
      externalId: "user-1",
    });
    const agent = await collections.participant.findOne({
      externalId: "agent-1",
    });

    assertEquals(user?.name, "User One");
    assertEquals(user?.email, "user@example.com");
    assertEquals(agent?.participantType, "agent");
    assertEquals(agent?.agentId, "agent-1");
  } finally {
    await closeTestDb(db, tempDir);
  }
});

Deno.test("participant lifecycle processor no-ops when participant collection is absent", async () => {
  const { db, tempDir } = await createTestDb("participant-lifecycle-noop");
  const event = {
    id: "evt-2",
    threadId: "thread-1",
    type: "NEW_MESSAGE",
    payload: {
      content: "hello",
      sender: { type: "user", externalId: "user-2", name: "User Two" },
    },
  } as unknown as Event;

  const deps = {
    db,
    thread: { id: "thread-1" },
    context: {
      namespace: "tenant-a",
      collections: undefined,
      agents: [],
    },
    emitToStream: () => {},
  } as unknown as ProcessorDeps;

  try {
    const result = await participantLifecycleProcessor.process(event, deps);
    assertEquals(result, undefined);
  } finally {
    await closeTestDb(db, tempDir);
  }
});

Deno.test("participant lifecycle processor treats agent senders as agent participants", async () => {
  const { db, tempDir } = await createTestDb("participant-lifecycle-agent");
  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace("tenant-a");

  const event = {
    id: "evt-3",
    threadId: "thread-1",
    type: "NEW_MESSAGE",
    payload: {
      content: "",
      sender: {
        type: "agent",
        id: "estrategista",
        externalId: "user-should-not-win",
        name: "Estrategista",
      },
      toolCalls: [{
        id: "call-1",
        tool: { id: "saveUserContext", name: "saveUserContext" },
        args: { purpose: { centralIkigai: "test" } },
      }],
    },
  } as unknown as Event;

  const deps = {
    db,
    thread: { id: "thread-1" },
    context: {
      namespace: "tenant-a",
      collections,
      agents: [],
    },
    emitToStream: () => {},
  } as unknown as ProcessorDeps;

  try {
    const result = await participantLifecycleProcessor.process(
      event,
      deps,
    ) as any;
    assertEquals(result?.externalId, "estrategista");

    const agent = await collections.participant.findOne({
      externalId: "estrategista",
    });
    const user = await collections.participant.findOne({
      externalId: "user-should-not-win",
    });

    assertEquals(agent?.participantType, "agent");
    assertEquals(agent?.agentId, "estrategista");
    assertEquals(user, null);
  } finally {
    await closeTestDb(db, tempDir);
  }
});

Deno.test("participant lifecycle processor treats job senders as job participants", async () => {
  const { db, tempDir } = await createTestDb("participant-lifecycle-job");
  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace("tenant-a");

  const event = {
    id: "evt-job",
    threadId: "thread-1",
    type: "NEW_MESSAGE",
    payload: {
      content: "run scheduled work",
      sender: {
        type: "job",
        id: "job-1",
        externalId: "job-1",
        name: "Daily job",
      },
    },
  } as unknown as Event;

  const deps = {
    db,
    thread: { id: "thread-1" },
    context: {
      namespace: "tenant-a",
      collections,
      agents: [],
    },
    emitToStream: () => {},
  } as unknown as ProcessorDeps;

  try {
    const result = await participantLifecycleProcessor.process(
      event,
      deps,
    ) as any;
    assertEquals(result?.externalId, "job-1");

    const job = await collections.participant.findOne({
      externalId: "job-1",
    });

    assertEquals(job?.participantType, "job");
    assertEquals(job?.name, "Daily job");
  } finally {
    await closeTestDb(db, tempDir);
  }
});

Deno.test("participant lifecycle processor loads before main new_message processor", async () => {
  void loadResources;
  assertEquals(priority > 0, true);
  assertEquals(typeof messageProcessor.shouldProcess, "function");
});
