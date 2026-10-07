import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createCopilotzEngine } from "../../../runtime/engine/index.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../core/shared/testing/context.ts";
import { materializeBuiltinModel } from "../../llm/adapters/builtin/index.ts";
import { memoryPlugin } from "../plugin.ts";
import { ensureWritableMemorySpace, threadMemorySpaces } from "./access.ts";
import { activeMemoryNotes } from "./retrieval.ts";
import { memoryContextResource } from "../resources/promptContext/memory/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";

Deno.test("Space memory is read-only, isolated and revocable across all consumers", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [memoryPlugin],
    resources: { memory: { config: { enabled: false } } },
  });
  const engine = await createCopilotzEngine({
    session: db,
    registry,
    defaultDatabaseSchema: "space_memory",
  });
  const context = createTestDomainContext(engine, "tenant");
  const c = context.collections;
  const memoryContext = context as unknown as MemoryProcessorContext;
  const scope = (id: string) => `memory-space:thread:${id}`;
  const attach = (thread: string, spaceId: string) =>
    context.actions.spaces({
      operation: "attach",
      spaceId,
      collection: "thread",
      recordId: thread,
    });
  const search = async (threadId: string) => {
    const result = await context.actions.search_memory({ query: "remember" }, {
      metadata: { threadId, agentId: "reader" },
    }) as { notes: { id: string }[] };
    return result.notes.map((m) => m.id).sort();
  };
  const resource = memoryContextResource;
  const prompt = () =>
    resource.contribute({
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
  // Opt-in: exercise the actual provider adapter using only synthetic test facts.
  const liveModel = Deno.env.get("COPILOTZ_LIVE_MODEL");
  async function liveRecall() {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey || !liveModel) throw new Error("Live test model/key missing.");
    const options = { estimateCost: false, maxCompletionTokens: 100 };
    const adapter = materializeBuiltinModel(
      { provider: "openai", model: liveModel, apiKey },
      "generate",
      options,
    );
    const contribution = await prompt();
    const entries = contribution
      ? Array.isArray(contribution) ? contribution : [contribution]
      : [];
    const memoryText = entries.map((entry) =>
      typeof entry.content === "string"
        ? entry.content
        : JSON.stringify(entry.content)
    ).join("\n");
    const call = adapter.call({
      adapter: "openai",
      model: liveModel,
      providerModel: liveModel,
      mode: "generate",
      fallbackAvailable: false,
      options,
      signal: AbortSignal.timeout(45_000),
      request: {
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text:
              "Extract the literal code matching secret-[a-z] from this text. Output that code verbatim. If no such code occurs, output NONE.\n\n" +
              memoryText,
          }],
        }],
      },
    });
    const drain = (async () => {
      for await (const _frame of call.frames) { /* consume provider stream */ }
    })();
    const [result] = await Promise.all([call.result, drain]);
    return JSON.stringify(result.content);
  }
  try {
    await c.participant.create({
      id: "owner",
      externalId: "owner",
      participantType: "human",
    });
    for (const spaceId of ["one", "two"]) {
      await context.actions.spaces({
        operation: "create",
        spaceId,
        ownerId: "owner",
      });
    }
    for (const id of ["a", "b", "c"]) {
      await c.thread.create({ id });
      await ensureWritableMemorySpace(memoryContext, id);
      await c.longTermMemory.create({
        id: `checkpoint-${id}`,
        threadId: id,
        schemaVersion: "4",
        strategy: "semantic_graph",
        status: "ready",
        sequence: 0,
        agentId: `writer-${id}`,
        sourceStartMessageId: "m",
        sourceEndMessageId: "m",
        readMemorySpaceIds: [scope(id)],
      });
      await c.memoryNote.create({
        id: `fact-${id}`,
        memorySpaceId: scope(id),
        consolidationId: `checkpoint-${id}`,
        createdByAgentId: `writer-${id}`,
        originThreadId: id,
        text: `remember secret-${id}`,
        sources: [],
        retirement: null,
      });
    }
    const original = await c.memoryNote.list({ order: { field: "id" } });
    assertEquals(await search("a"), ["fact-a"]);
    await attach("a", "one");
    await attach("b", "one");
    await attach("c", "two");
    assertEquals(await search("a"), ["fact-a", "fact-b"]);
    assertEquals(await search("b"), ["fact-a", "fact-b"]);
    assertEquals(await search("c"), ["fact-c"]);
    const spaces = await threadMemorySpaces(context, "a");
    assertEquals(spaces.map((s) => [s.id, s.access, s.defaultWrite]), [[
      scope("a"),
      "read_write",
      true,
    ], [scope("b"), "read", false]]);
    const visible = await activeMemoryNotes(context, spaces, 20);
    assertEquals(visible.notes.map((note) => note.id).sort(), [
      "fact-a",
      "fact-b",
    ]);
    assertStringIncludes(JSON.stringify(await prompt()), "secret-b");
    if (liveModel) {
      const answer = await liveRecall();
      assertStringIncludes(answer, "secret-b");
      assert(!answer.includes("secret-c"));
    }
    assert(!JSON.stringify(await prompt()).includes("secret-c"));
    const inaccessible = await context.actions.inspect_memory({
      ids: ["fact-c", "missing"],
    }, {
      metadata: { threadId: "a", agentId: "reader" },
    });
    assertEquals(inaccessible, {
      notes: [],
      unavailableIds: ["fact-c", "missing"],
    });
    const checkpoint = {
      id: "old",
      namespace: "tenant",
      createdAt: "2026-09-15T00:00:00Z",
      updatedAt: "2026-09-15T00:00:00Z",
      readMemorySpaceIds: [scope("a"), scope("b")],
    };
    await c.longTermMemory.create({
      id: "old",
      threadId: "a",
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "ready",
      sequence: 1,
      agentId: "reader",
      sourceStartMessageId: "m",
      sourceEndMessageId: "m",
      readMemorySpaceIds: checkpoint.readMemorySpaceIds,
      content: [{ type: "text", text: "STALE_SHARED_SECRET" }],
      metadata: {
        coverage: {
          schema: "copilotz.memory.coverage.v1",
          agentParticipantId: "reader",
          branch: "public",
          startMessageId: "m",
          endMessageId: "m",
          continuity: "THREAD_OWNED_CONTINUITY",
        },
      },
    });
    for (const operation of ["archive", "restore"] as const) {
      await context.actions.spaces({ operation, spaceId: "one" });
      assertEquals(
        await search("a"),
        operation === "archive" ? ["fact-a"] : ["fact-a", "fact-b"],
      );
      if (operation === "archive") {
        const rendered = JSON.stringify(await prompt());
        assertStringIncludes(rendered, "THREAD_OWNED_CONTINUITY");
        assert(!rendered.includes("secret-b"));
        assert(!rendered.includes("STALE_SHARED_SECRET"));
      }
    }
    await attach("b", "two");
    assertEquals(await search("a"), ["fact-a"]);
    assertEquals(await search("b"), ["fact-b", "fact-c"]);
    assertStringIncludes(
      JSON.stringify(await prompt()),
      "THREAD_OWNED_CONTINUITY",
    );
    assert(!JSON.stringify(await prompt()).includes("secret-b"));
    await attach("b", "one");
    await context.actions.spaces({
      operation: "detach",
      spaceId: "one",
      collection: "thread",
      recordId: "b",
    });
    assertEquals(await search("a"), ["fact-a"]);
    assertEquals(await search("b"), ["fact-b"]);
    assertStringIncludes(
      JSON.stringify(await prompt()),
      "THREAD_OWNED_CONTINUITY",
    );
    assert(!JSON.stringify(await prompt()).includes("secret-b"));
    if (liveModel) assert(!(await liveRecall()).includes("secret-b"));
    await attach("b", "one");
    await context.actions.spaces({ operation: "remove", spaceId: "one" });
    assertEquals(await search("a"), ["fact-a"]);
    assertEquals(await search("b"), ["fact-b"]);
    const finalPrompt = await prompt();
    assertStringIncludes(
      JSON.stringify(finalPrompt),
      "THREAD_OWNED_CONTINUITY",
    );
    assert(!JSON.stringify(finalPrompt).includes("secret-b"));
    assertEquals(
      (Array.isArray(finalPrompt) ? finalPrompt : [finalPrompt]).find((entry) =>
        entry?.id === "copilotz.long_term"
      )?.historyAfterMessageId,
      "m",
    );
    assertEquals(
      await c.memoryNote.list({ order: { field: "id" } }),
      original,
    );
    assertEquals((await c.memorySpaceAccess.list()).length, 3);
    assert(await c.thread.get({ id: "a" }));
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
