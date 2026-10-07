import { assert, assertEquals } from "@std/assert";
import {
  loadThreadRecord,
  mapMessageRecord,
  mapParticipantRecord,
} from "@copilotz/copilotz/core";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createCopilotzEngine } from "../../../runtime/engine/index.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../core/shared/testing/context.ts";
import { memoryPlugin } from "../plugin.ts";
import { ensureWritableMemorySpace } from "./access.ts";
import { reserveMemoryCheckpoint } from "./reservation.ts";
import { checkpointHead, readyCheckpoint } from "./checkpoints.ts";

async function concurrentReservations(url: string) {
  const db = await createTestDatabase({ url, pgPoolMax: 8 });
  const schema = "memory_reserve_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const registry = await createPluginRegistry({
    plugins: [memoryPlugin],
    resources: {
      memory: { config: { enabled: false } },
      agents: {
        west: { id: "west", name: "West", role: "assistant", models: {} },
      },
    },
  });
  const engines = [];
  try {
    for (let i = 0; i < 2; i++) {
      engines.push(
        await createCopilotzEngine({
          session: db,
          registry,
          defaultDatabaseSchema: schema,
        }),
      );
    }
    const contexts = engines.map((engine) =>
      createTestDomainContext(engine, "tenant")
    );
    const c = contexts[0].collections;
    const humanRecord = await c.participant.create({
      id: "human",
      externalId: "human",
      participantType: "human",
    });
    const ownerRecord = await c.participant.create({
      id: "west",
      externalId: "west",
      agentId: "west",
      participantType: "agent",
    });
    await c.thread.create({
      id: "development",
      participantIds: [humanRecord.id, ownerRecord.id],
    });
    const spaces = await ensureWritableMemorySpace(
      contexts[0] as never,
      "development",
    );
    const messages: ReturnType<typeof mapMessageRecord>[] = [];
    for (let i = 0; i < 21; i++) {
      const message = await c.message.create({
        id: `m${i}`,
        threadId: "development",
        senderId: humanRecord.id,
        recipientIds: [],
        content: [],
        metadata: {},
      });
      messages.push(
        mapMessageRecord(message, mapParticipantRecord(humanRecord)),
      );
    }
    const thread = await loadThreadRecord(contexts[0], "development");
    assert(thread);
    const owner = mapParticipantRecord(ownerRecord);
    const sources = messages.map((m) => ({
      id: m.id,
      senderType: "human",
      senderId: humanRecord.id,
      text: "synthetic source",
      estimatedTokens: 5_000,
    }));
    const trigger = await c.message.get({ id: messages.at(-1)!.id });
    assert(trigger);
    let selected = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => release = resolve);
    const config = {
      triggerEstimatedTokens: 1,
      retainRecentEstimatedTokens: 0,
      maxContentEstimatedTokens: 12_000,
      retrievalLimit: 20,
    };
    const reserve = async (caller: number, hold = false) => {
      const base = contexts[caller % 2];
      const bound = base.collections.longTermMemory;
      const context = {
        ...base,
        collections: {
          ...base.collections,
          longTermMemory: {
            ...bound,
            async list(query: Parameters<typeof bound.list>[0]) {
              const result = await bound.list(query);
              if (hold && query?.limit === 1 && !query.where?.status) {
                if (++selected === 32) release();
                await barrier;
              }
              return result;
            },
          },
        },
      };
      return await reserveMemoryCheckpoint(context as never, trigger, config, {
        ownerParticipantId: owner.id,
        historyLimitEstimatedTokens: caller % 2 ? 20_000 : 40_000,
        prepared: { owner, thread, messages, sources },
      });
    };
    const values = await Promise.all(
      Array.from({ length: 32 }, (_, caller) => reserve(caller, true)),
    );
    assert(values.every(Boolean));
    assertEquals(new Set(values.map((item) => item!.id)).size, 1);
    assertEquals((await c.longTermMemory.list()).length, 1);
    assertEquals(
      Number(
        (await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM "${schema}".events WHERE type='long_term_memory.created'`,
        )).rows[0].count,
      ),
      1,
    );
    const first = values[0]!;
    assertEquals((await reserve(40))!.id, first.id);
    await c.longTermMemory.update({ id: first.id, set: { status: "failed" } });
    const second = await reserve(41);
    assertEquals(second!.sequence, 2);
    await c.longTermMemory.update({
      id: second!.id,
      set: { status: "cancelled" },
    });
    const third = await reserve(42);
    assertEquals(third!.sequence, 3);
    const metadata = third!.metadata as Record<string, unknown>;
    await c.longTermMemory.update({
      id: third!.id,
      set: {
        status: "ready",
        metadata: {
          ...metadata,
          coverage: {
            ...(metadata.coverageCandidate as object),
            continuity: "Certified continuity",
          },
        },
      },
    });
    assertEquals(
      (await reserve(43))!.id,
      third!.id,
      "stale prepared history reuses already-covered work",
    );
    // Ordinary semantic writes are independently idempotent and must not own
    // or block the automatic history-consolidation reservation.
    await c.longTermMemory.create({
      id: "semantic-on-demand",
      threadId: thread.id,
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "pending",
      sequence: 500,
      agentId: "west",
      memorySpaceId: spaces[0].id,
      sourceStartMessageId: messages[0].id,
      sourceEndMessageId: trigger.id,
      metadata: { onDemand: true },
    });
    assertEquals((await reserve(44))!.id, third!.id);
    assertEquals((await c.longTermMemory.list()).length, 4);
    // Regression: 0.85.3 silently ordered IDs and selected :9 over :40.
    // Creation order deliberately differs from sequence order as well.
    for (const sequence of [9, 10, 40, 100, 99]) {
      await c.longTermMemory.create({
        ...third!,
        id: `memory:${thread.id}:west:${sequence}`,
        sequence,
        status: "ready",
        metadata: {
          ...metadata,
          coverage: {
            ...(metadata.coverageCandidate as object),
            continuity: `Continuity ${sequence}`,
          },
        },
      });
    }
    assertEquals(
      (await checkpointHead(contexts[0] as never, thread.id, "west"))!.sequence,
      100,
    );
    assertEquals(
      (await readyCheckpoint(contexts[0] as never, {
        thread,
        agentId: "west",
        participantId: owner.id,
      }))!.sequence,
      100,
    );
    assertEquals((await reserve(45))!.sequence, 100);
    await c.longTermMemory.update({
      id: `memory:${thread.id}:west:100`,
      set: { status: "failed" },
    });
    const next = await Promise.all(
      Array.from({ length: 32 }, (_, caller) => reserve(caller)),
    );
    assertEquals(new Set(next.map((row) => row!.id)).size, 1);
    assertEquals(next[0]!.sequence, 101);
  } finally {
    for (const engine of engines) await engine.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("memory reservations share one checkpoint across concurrent PGlite engines", () =>
  concurrentReservations(":memory:"));
const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "memory reservations share one checkpoint across concurrent PostgreSQL engines",
  ignore: !postgres,
  fn: () => concurrentReservations(postgres!),
});
