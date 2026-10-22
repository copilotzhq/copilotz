import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createCopilotzEngine } from "@copilotz/copilotz/engine";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../core/shared/testing/context.ts";
import { memoryPlugin } from "../plugin.ts";
import { ensureWritableMemorySpace, threadMemorySpaces } from "./access.ts";
import { memoryContextResource } from "../resources/promptContext/memory/index.ts";

Deno.test("thread continuity stays local when threads share or leave a Core space", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const registry = await createPluginRegistry({
    plugins: [memoryPlugin],
    resources: { memory: { config: { enabled: false } } },
  });
  const engine = await createCopilotzEngine({
    session: db,
    registry,
    defaultDatabaseSchema: `memory_continuity_${
      crypto.randomUUID().replaceAll("-", "")
    }`,
  });
  const context = createTestDomainContext(engine, "tenant");
  const c = context.collections;
  try {
    await c.participant.create({
      id: "owner",
      externalId: "owner",
      participantType: "human",
    });
    await context.actions.spaces({
      operation: "create",
      spaceId: "one",
      ownerId: "owner",
    });
    for (const id of ["a", "b"]) {
      await c.thread.create({ id });
      await ensureWritableMemorySpace(context as never, id);
      await context.actions.spaces({
        operation: "attach",
        spaceId: "one",
        collection: "thread",
        recordId: id,
      });
      await context.actions.remember({ text: `continuity-${id}` }, {
        metadata: { threadId: id, agentId: "reader" },
      });
    }
    await c.longTermMemory.create({
      id: "checkpoint",
      threadId: "a",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "ready",
      sequence: 1,
      agentId: "reader",
      sourceStartMessageId: "m",
      sourceEndMessageId: "m",
      readMemorySpaceIds: ["memory-space:thread:a", "memory-space:thread:b"],
      metadata: {
        coverage: {
          schema: "copilotz.memory.coverage.v1",
          agentParticipantId: "reader",
          branch: "public",
          startMessageId: "m",
          endMessageId: "m",
          continuity: "OWN_CHECKPOINT",
        },
      },
    });
    const prompt = () =>
      memoryContextResource.contribute({
        context: {
          ...context,
          resources: {
            ...context.resources,
            memory: { config: { enabled: true } },
          },
        },
        collections: c,
        thread: { id: "a" },
        agent: { id: "reader" },
        participant: { id: "reader" },
        signal: new AbortController().signal,
      } as never);
    for (const operation of ["archive", "restore"] as const) {
      await context.actions.spaces({ operation, spaceId: "one" });
      const rendered = JSON.stringify(await prompt());
      assertStringIncludes(rendered, "OWN_CHECKPOINT");
      assertStringIncludes(rendered, "continuity-a");
      assert(!rendered.includes("continuity-b"));
    }
    await context.actions.spaces({
      operation: "detach",
      spaceId: "one",
      collection: "thread",
      recordId: "a",
    });
    assertStringIncludes(JSON.stringify(await prompt()), "OWN_CHECKPOINT");
    assertEquals((await threadMemorySpaces(context, "a")).map((s) => s.id), [
      "memory-space:thread:a",
    ]);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
