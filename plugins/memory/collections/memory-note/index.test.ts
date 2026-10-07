import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { memoryNoteCollection } from "./index.ts";
import { defineCollection } from "@copilotz/copilotz/collections";

Deno.test("notes preserve text and identity while sources and retirement remain append-only", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const app = await createCopilotzApplication({
    database: db,
    databaseSchema: "note_immutability",
    namespace: "tenant",
    collections: {
      memoryNote: memoryNoteCollection,
      space: defineCollection({
        name: "memory_space",
        schema: { type: "object" },
      }),
      checkpoint: defineCollection({
        name: "long_term_memory",
        schema: { type: "object" },
      }),
    },
  });
  try {
    const notes =
      app.collections.withScope({ namespace: "tenant" }).memory_note;
    const collections = app.collections.withScope({ namespace: "tenant" });
    await collections.memory_space.create({ id: "scope" });
    await collections.long_term_memory.create({ id: "checkpoint" });
    const note = await notes.create({
      id: "note",
      text: "Release steps:\n  1. Test\n  2. Publish",
      memorySpaceId: "scope",
      consolidationId: "checkpoint",
      createdByAgentId: "agent",
      originThreadId: "thread",
      sources: [{ type: "message", id: "message-1" }],
      retirement: null,
    });
    await assertRejects(
      () => notes.update({ id: note.id, set: { text: "changed" } }),
      TypeError,
      "immutable",
    );
    await assertRejects(
      () => notes.update({ id: note.id, set: { memorySpaceId: "other" } }),
      TypeError,
      "immutable",
    );
    await assertRejects(
      () => notes.update({ id: note.id, set: { sources: [] } }),
      TypeError,
      "append-only",
    );
    await notes.commands.addSources({
      id: note.id,
      memorySpaceId: "scope",
      sources: [{ type: "message", id: "message-2" }],
      originThreadId: "thread",
      createdByAgentId: "agent",
    });
    await notes.commands.addSources({
      id: note.id,
      memorySpaceId: "scope",
      originThreadId: "different-thread",
      createdByAgentId: "different-agent",
      sources: [{ type: "message", id: "private-cross-origin" }],
    }, { operationKey: "cross-origin-reuse" });
    assertEquals((await notes.get({ id: note.id }))?.sources, [{
      type: "message",
      id: "message-1",
    }, { type: "message", id: "message-2" }]);
    const retired = await notes.commands.retire({
      id: note.id,
      memorySpaceId: "scope",
      retirement: {
        checkpointId: "next",
        retiredAt: "2026-10-07T00:00:00.000Z",
        retiredBy: "agent",
        reason: "Corrected release instructions",
        replacedBy: "replacement",
      },
    });
    assertEquals(retired.text, note.text);
    assertEquals((retired.sources as unknown[]).length, 2);
    await assertRejects(
      () => notes.update({ id: note.id, set: { retirement: null } }),
      TypeError,
      "permanent",
    );
    await assertRejects(
      () =>
        notes.commands.addSources({
          id: note.id,
          memorySpaceId: "scope",
          sources: [],
          originThreadId: "thread",
          createdByAgentId: "agent",
        }),
      Error,
      "no longer active",
    );
    await assertRejects(
      () =>
        notes.commands.retire({
          id: note.id,
          memorySpaceId: "scope",
          retirement: {
            checkpointId: "raced",
            retiredAt: "2026-10-07T00:00:00.000Z",
            retiredBy: "other",
            reason: "raced",
          },
        }),
      Error,
      "no longer active",
    );
  } finally {
    await app.shutdown();
    await db.close();
  }
});
