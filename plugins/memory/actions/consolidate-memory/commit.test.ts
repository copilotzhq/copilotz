import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createCopilotzEngine } from "../../../../runtime/engine/index.ts";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createTestDomainContext } from "../../../core/shared/testing/context.ts";
import { memoryPlugin } from "../../plugin.ts";
import { commitMemoryConsolidation } from "./commit.ts";
import { prepareMemoryProposal } from "../../authoring/notes/index.ts";
import { memoryNote } from "../../shared/retrieval.ts";

Deno.test("a stale note replacement rolls back every new note and leaves checkpoint coverage unchanged", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: db,
    defaultDatabaseSchema: "memory_atomic_replacement",
    registry: await createPluginRegistry({
      plugins: [memoryPlugin],
      resources: { memory: { config: { enabled: false } } },
    }),
  });
  const context = createTestDomainContext(engine, "tenant");
  try {
    const c = context.collections;
    await c.thread.create({ id: "thread" });
    await c.memorySpace.create({
      id: "space",
      scopeType: "thread",
      scopeId: "thread",
      threadId: "thread",
    });
    await c.memorySpaceAccess.create({
      id: "grant",
      threadId: "thread",
      memorySpaceId: "space",
      access: "read_write",
      defaultWrite: true,
    });
    for (const [id, sequence] of [["old", 1], ["new", 2]] as const) {
      await c.longTermMemory.create({
        id,
        threadId: "thread",
        schemaVersion: "5",
        strategy: "notes",
        status: "pending",
        sequence,
        agentId: "agent",
        sourceStartMessageId: "start",
        sourceEndMessageId: "end",
      });
    }
    const old = await c.memoryNote.create({
      id: "note-old",
      text: "Not yet deployed.",
      memorySpaceId: "space",
      consolidationId: "old",
      createdByAgentId: "agent",
      originThreadId: "thread",
      sources: [],
      retirement: null,
    });
    const proposal = prepareMemoryProposal({
      continuity: "Release complete.",
      remember: [
        { text: "Release is deployed.", replaces: [old.id] },
        { text: "Independent second note." },
      ],
    }, {
      checkpointId: "new",
      writeScopeId: "space",
      notes: [memoryNote(old)],
      sources: new Map(),
    });
    const prepared = await context.content.prepare({
      type: "text",
      text: proposal.continuity,
    }, { operationKey: "checkpoint-content" });
    await c.memoryNote.commands.retire({
      id: old.id,
      memorySpaceId: "space",
      retirement: {
        checkpointId: "other",
        retiredAt: "2026-10-07T00:00:00Z",
        retiredBy: "other",
        reason: "Concurrent correction",
      },
    });
    const input = {
      checkpointId: "new",
      writeScopeId: "space",
      writeGrantId: "grant",
      agentId: "agent",
      threadId: "thread",
      recordedAt: "2026-10-07T00:00:00Z",
      proposal,
      vectors: [],
      checkpointPatch: {
        status: "ready",
        metadata: { coverage: { endMessageId: "end" } },
      },
      checkpointContent: prepared,
    };
    await assertRejects(
      () => commitMemoryConsolidation(context as never, input),
      Error,
      "no longer active",
    );
    assertEquals((await c.memoryNote.list()).map((note) => note.id), [old.id]);
    assertEquals(
      (await c.longTermMemory.get({ id: "new" }))?.status,
      "pending",
    );
    assertEquals(
      (await c.longTermMemory.get({ id: "new" }))?.metadata,
      undefined,
    );
    // Revoking the grant after preparation rejects the same atomic batch.
    await c.memorySpaceAccess.update({ id: "grant", set: { access: "read" } });
    await assertRejects(
      () =>
        commitMemoryConsolidation(context as never, {
          ...input,
          proposal: { ...proposal, notes: [], retire: [] },
        }),
      Error,
      "write grant",
    );
    assertEquals(
      (await c.longTermMemory.get({ id: "new" }))?.status,
      "pending",
    );
    await c.memorySpaceAccess.update({
      id: "grant",
      set: { access: "read_write" },
    });
    // A corrected proposal reuses the owning checkpoint and commits normally.
    const corrected = prepareMemoryProposal({
      continuity: "Release complete.",
      remember: [{ text: "Release is deployed." }],
    }, {
      checkpointId: "new",
      writeScopeId: "space",
      notes: [],
      sources: new Map(),
    });
    await commitMemoryConsolidation(context as never, {
      ...input,
      proposal: corrected,
    });
    assertEquals((await c.longTermMemory.get({ id: "new" }))?.status, "ready");
    assertEquals((await c.memoryNote.list()).length, 2);
    assertEquals((await c.memoryNote.get({ id: old.id }))?.text, old.text);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

for (const target of ["grant", "reused-note"] as const) {
  Deno.test(`atomic no-change fence rejects concurrent ${target} invalidation after planning`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const registry = await createPluginRegistry({
      plugins: [memoryPlugin],
      resources: { memory: { config: { enabled: false } } },
    });
    const engine = await createCopilotzEngine({
      session: db,
      registry,
      defaultDatabaseSchema: "memory_fence",
    });
    // A second kernel has an independent transaction-planning context, as another
    // request/process would. Its change commits after our plan, before our SQL.
    const concurrent = await createCopilotzEngine({
      session: db,
      registry,
      defaultDatabaseSchema: "memory_fence",
      provisionDefaultDatabaseSchema: false,
    });
    const context = createTestDomainContext(engine, "tenant");
    const other = createTestDomainContext(concurrent, "tenant");
    try {
      const c = context.collections;
      await c.thread.create({ id: "thread" });
      await c.memorySpace.create({
        id: "space",
        scopeType: "thread",
        scopeId: "thread",
      });
      await c.memorySpaceAccess.create({
        id: "grant",
        threadId: "thread",
        memorySpaceId: "space",
        access: "read_write",
        defaultWrite: true,
      });
      await c.longTermMemory.create({
        id: "checkpoint",
        threadId: "thread",
        schemaVersion: "5",
        strategy: "notes",
        status: "pending",
        sequence: 1,
        agentId: "agent",
        sourceStartMessageId: "m",
        sourceEndMessageId: "m",
      });
      const existing = await c.memoryNote.create({
        id: "existing",
        text: "Stable fact.",
        memorySpaceId: "space",
        consolidationId: "checkpoint",
        createdByAgentId: "agent",
        originThreadId: "thread",
        sources: [],
        retirement: null,
      });
      const proposal = prepareMemoryProposal({
        continuity: "Continue.",
        remember: [{ text: "Stable fact." }, { text: "Fresh fact." }],
      }, {
        checkpointId: "checkpoint",
        writeScopeId: "space",
        notes: [memoryNote(existing)],
        sources: new Map(),
      });
      const checkpointContent = await context.content.prepare({
        type: "text",
        text: proposal.continuity,
      }, { operationKey: "content" });
      const racingContext = {
        ...context,
        transaction: (execute, options) =>
          context.transaction(async (tx) => {
            const value = await execute(tx);
            if (target === "grant") {
              await other.collections.memorySpaceAccess.update({
                id: "grant",
                set: { access: "read" },
              });
            } else {await other.collections.memoryNote.commands.retire({
                id: "existing",
                memorySpaceId: "space",
                retirement: {
                  checkpointId: "competing",
                  retiredAt: "2026-10-07",
                  retiredBy: "other",
                  reason: "Corrected",
                },
              });}
            return value;
          }, options),
      } satisfies typeof context;
      await assertRejects(
        () =>
          commitMemoryConsolidation(racingContext as never, {
            checkpointId: "checkpoint",
            writeScopeId: "space",
            writeGrantId: "grant",
            agentId: "agent",
            threadId: "thread",
            recordedAt: "2026-10-07",
            proposal,
            vectors: [],
            checkpointPatch: { status: "ready" },
            checkpointContent,
          }),
        Error,
        "changed while",
      );
      assertEquals(
        (await c.longTermMemory.get({ id: "checkpoint" }))?.status,
        "pending",
      );
      assertEquals((await c.memoryNote.list()).map((value) => value.id), [
        "existing",
      ]);
    } finally {
      await concurrent.shutdown();
      await engine.shutdown();
      await db.close();
    }
  });
}
