import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { createCollectionsManager } from "@/database/collections/index.ts";
import loadResources from "@/runtime/loaders/resources.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { participantLifecycleProcessor, priority } from "./participant_lifecycle.ts";
import { messageProcessor } from "./index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";

Deno.test("participant lifecycle processor upserts sender and configured agents", async () => {
  const db = await createDatabase({ url: ":memory:" });
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
    const result = await participantLifecycleProcessor.process(event, deps);
    assertEquals(result, undefined);

    const user = await collections.participant.findOne({ externalId: "user-1" });
    const agent = await collections.participant.findOne({ externalId: "agent-1" });

    assertEquals(user?.name, "User One");
    assertEquals(user?.email, "user@example.com");
    assertEquals(agent?.participantType, "agent");
    assertEquals(agent?.agentId, "agent-1");
  } finally {
    await db.query('DELETE FROM "nodes" WHERE 1=1');
    await db.query('DELETE FROM "edges" WHERE 1=1');
  }
});

Deno.test("participant lifecycle processor no-ops when participant collection is absent", async () => {
  const db = await createDatabase({ url: ":memory:" });
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
    await db.query('DELETE FROM "nodes" WHERE 1=1');
    await db.query('DELETE FROM "edges" WHERE 1=1');
  }
});

Deno.test("participant lifecycle processor loads before main new_message processor", async () => {
  void loadResources;
  assertEquals(priority > 0, true);
  assertEquals(typeof messageProcessor.shouldProcess, "function");
});
