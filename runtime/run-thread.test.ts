import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCopilotz } from "@/index.ts";
import { withSchema } from "@/database/schema-context.ts";
import { normalizeThreadMetadata } from "@/runtime/thread-metadata.ts";

Deno.test("runThread writes tenant queue rows in the active schema", async () => {
  const tenant = "tenant_copilotz_com";
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [{
      id: "tenant-agent",
      name: "tenant-agent",
      role: "assistant",
      instructions: "Handle the tenant message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => ({ producedEvents: [] }),
    }],
    dbConfig: { url: `file://${tempDir}/tenant-schema-run.db` },
  });

  try {
    const handle = await copilotz.run({
      content: "hello tenant",
      sender: { type: "user", externalId: "tenant-user", name: "Tenant User" },
      thread: { externalId: "tenant-thread" },
    }, {
      namespace: tenant,
      schema: tenant,
    });

    let timeoutId: number | undefined;
    try {
      await Promise.race([
        handle.done,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("tenant runThread did not complete")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    const tenantThreads = await withSchema(
      tenant,
      () =>
        copilotz.db.query<{ id: string; namespace: string | null }>(
          `SELECT "id", "namespace" FROM "threads" WHERE "id" = $1`,
          [handle.threadId],
        ),
    );
    const tenantEvents = await withSchema(tenant, () =>
      copilotz.db.query<
        { id: string; namespace: string | null; status: string }
      >(
        `SELECT "id", "namespace", "status" FROM "events" WHERE "threadId" = $1`,
        [handle.threadId],
      ));
    const publicThreads = await copilotz.db.query<{ id: string }>(
      `SELECT "id" FROM "threads" WHERE "id" = $1`,
      [handle.threadId],
    );
    const publicEvents = await copilotz.db.query<{ id: string }>(
      `SELECT "id" FROM "events" WHERE "threadId" = $1`,
      [handle.threadId],
    );

    assertEquals(tenantThreads.rows.length, 1);
    assertEquals(tenantThreads.rows[0].namespace, tenant);
    assertEquals(tenantEvents.rows.length, 1);
    assertEquals(tenantEvents.rows[0].namespace, tenant);
    assertEquals(tenantEvents.rows[0].status, "completed");
    assertEquals(publicThreads.rows.length, 0);
    assertEquals(publicEvents.rows.length, 0);
    assert(handle.threadId);
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runThread keeps done pending for same-thread work queued behind an active worker", async () => {
  const copilotz = await createCopilotz({
    agents: [{
      id: "test-agent",
      name: "Test Agent",
      role: "Test Agent",
      instructions: "Handle the test message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { producedEvents: [] };
      },
    }],
    dbConfig: {
      url: ":memory:",
      threadLeaseMs: 1_000,
      threadLeaseHeartbeatMs: 100,
    },
  });

  try {
    const baseMessage = {
      sender: { type: "user" as const, externalId: "user-1", name: "User 1" },
      thread: { externalId: "thread-1" },
    };

    const first = await copilotz.run({
      ...baseMessage,
      content: "first",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await copilotz.run({
      ...baseMessage,
      content: "second",
    });

    let secondDoneResolved = false;
    second.done.then(() => {
      secondDoneResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const queuedItem = await copilotz.ops.getQueueItemById(second.queueId);
    assertEquals(queuedItem?.status, "pending");
    assertEquals(secondDoneResolved, false);

    await second.done;

    const completedItem = await copilotz.ops.getQueueItemById(second.queueId);
    assertEquals(completedItem?.status, "completed");

    await first.done;
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("runThread normalizes blank thread participants and keeps a stable user identity", async () => {
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [{
      id: "reviewer",
      name: "reviewer",
      role: "assistant",
      instructions: "Handle the test message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => ({ producedEvents: [] }),
    }],
    dbConfig: { url: `file://${tempDir}/run-thread-identity.db` },
  });

  try {
    const handle = await copilotz.run({
      content: "hello",
      sender: { type: "user", name: "User" },
      thread: {
        externalId: "thread-identity-normalization",
        participants: ["", "reviewer"],
      },
    });

    let timeoutId: number | undefined;
    try {
      await Promise.race([
        handle.done,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runThread did not complete")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    const thread = await copilotz.ops.getThreadByExternalId(
      "thread-identity-normalization",
    );

    assertEquals(thread?.participants, ["User", "reviewer"]);

    const normalized = normalizeThreadMetadata(thread?.metadata);
    assertEquals(normalized.system?.memory?.identity?.userExternalId, "User");
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runThread defaults thread participants to explicit agents without injecting bundled agents", async () => {
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [{
      id: "assistant",
      name: "Assistant",
      role: "assistant",
      instructions: "Handle the test message.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => ({ producedEvents: [] }),
    }],
    dbConfig: { url: `file://${tempDir}/run-thread-default-participants.db` },
  });

  try {
    const handle = await copilotz.run({
      content: "hello",
      sender: { type: "user", name: "User" },
      thread: { externalId: "default-participants-thread" },
    });

    await handle.done;

    const thread = await copilotz.ops.getThreadByExternalId(
      "default-participants-thread",
    );

    assertEquals(thread?.participants, ["User", "assistant"]);
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});
