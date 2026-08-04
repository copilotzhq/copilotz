import { assertEquals } from "@std/assert";

import { createDatabase } from "@/database/index.ts";
import { buildProcessingContext } from "@/runtime/agent-llm-input/index.ts";
import { recoverStuckThreads } from "@/runtime/index.ts";
import {
  getSerializableThreadMetadata,
  setMemoryThreadMetadata,
} from "@/runtime/thread-metadata.ts";
import type {
  ChatContext,
  EventProcessor,
  ProcessorDeps,
} from "@/types/index.ts";

Deno.test({
  name: "recoverStuckThreads wakes pending work without a new message",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const thread = await db.ops.findOrCreateThread(undefined, {
      name: "Recovered Thread",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const queued = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "resume me" },
      priority: 0,
    });
    let processed = 0;
    const processor: EventProcessor<unknown, ProcessorDeps> = {
      shouldProcess: () => true,
      process: () => {
        processed += 1;
        return { producedEvents: [] };
      },
    };

    const result = await recoverStuckThreads(db, {
      processors: { NEW_MESSAGE: [processor] },
    });

    const item = await db.ops.getQueueItemById(String(queued.id));
    assertEquals(result.checked, 1);
    assertEquals(result.started, 1);
    assertEquals(result.threadIds, [thread.id]);
    assertEquals(processed, 1);
    assertEquals(item?.status, "completed");
  },
});

Deno.test({
  name: "recoverStuckThreads isolates discovered user metadata by thread",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const threadA = await db.ops.findOrCreateThread(undefined, {
      name: "Recovered user A",
      participants: ["user-a", "agent"],
      status: "active",
      mode: "immediate",
      metadata: getSerializableThreadMetadata(
        setMemoryThreadMetadata(undefined, {
          identity: { userExternalId: "user-a" },
        }),
      ),
    });
    const threadB = await db.ops.findOrCreateThread(undefined, {
      name: "Recovered user B",
      participants: ["user-b", "agent"],
      status: "active",
      mode: "immediate",
      metadata: getSerializableThreadMetadata(
        setMemoryThreadMetadata(undefined, {
          identity: { userExternalId: "user-b" },
        }),
      ),
    });
    await Promise.all(
      [threadA, threadB].map((thread) =>
        db.ops.addToQueue(String(thread.id), {
          eventType: "NEW_MESSAGE",
          payload: { content: "resume metadata" },
          priority: 0,
        })
      ),
    );

    const metadataByUser = {
      "user-a": { ab_tests: { prompt: { variant: "A" } } },
      "user-b": { ab_tests: { prompt: { variant: "B" } } },
    };
    const lookups: string[] = [];
    const resolvedByUser: Record<string, Record<string, unknown> | undefined> =
      {};
    const continuedByUser: Record<string, Record<string, unknown> | undefined> =
      {};
    const userByThreadId = {
      [String(threadA.id)]: "user-a",
      [String(threadB.id)]: "user-b",
    };
    let releaseUserB!: () => void;
    const userAResolved = new Promise<void>((resolve) => {
      releaseUserB = resolve;
    });

    const participant = {
      resolveByExternalId: (externalId: string) => {
        lookups.push(externalId);
        return Promise.resolve({
          id: `participant-${externalId}`,
          externalId,
          metadata: metadataByUser[externalId as keyof typeof metadataByUser],
        });
      },
    };
    const resolveMetadata: EventProcessor<unknown, ProcessorDeps> = {
      shouldProcess: () => true,
      process: async (_event, deps) => {
        const threadId = String(deps.thread.id);
        const userExternalId = userByThreadId[threadId];
        if (userExternalId === "user-b") await userAResolved;

        const processingContext = await buildProcessingContext(
          deps.db.ops,
          threadId,
          deps.context,
          "agent",
          undefined,
          "full",
          undefined,
          null,
          deps.thread,
        );
        resolvedByUser[userExternalId] = processingContext.userMetadata;
        if (userExternalId === "user-a") releaseUserB();

        return {
          producedEvents: [{
            type: "ACTION",
            threadId,
            payload: { kind: "verify-user-metadata" },
          }],
        };
      },
    };
    const verifyContinuation: EventProcessor<unknown, ProcessorDeps> = {
      shouldProcess: () => true,
      process: (_event, deps) => {
        const userExternalId = userByThreadId[String(deps.thread.id)];
        continuedByUser[userExternalId] = deps.context.userMetadata;
        return { producedEvents: [] };
      },
    };
    const context: ChatContext = {
      agents: [{ id: "agent", name: "Agent", role: "assistant" }],
      collections: { participant } as never,
      processors: {
        NEW_MESSAGE: [resolveMetadata],
        ACTION: [verifyContinuation],
      },
    };

    const result = await recoverStuckThreads(db, context);

    assertEquals(result.started, 2);
    assertEquals(lookups.sort(), ["user-a", "user-b"]);
    assertEquals(resolvedByUser["user-a"], metadataByUser["user-a"]);
    assertEquals(resolvedByUser["user-b"], metadataByUser["user-b"]);
    assertEquals(continuedByUser["user-a"], metadataByUser["user-a"]);
    assertEquals(continuedByUser["user-b"], metadataByUser["user-b"]);
    assertEquals(context.userMetadata, undefined);
  },
});
