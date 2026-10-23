import { withRetainedAuthority } from "../../../runtime/authorization/binding.ts";
import { testAuthority } from "../../../runtime/testing/authority.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createCopilotzEngine } from "@copilotz/copilotz/engine";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../core/shared/testing/context.ts";
import { memoryPlugin } from "../plugin.ts";
import { personalMemoryContext } from "../resources/promptContext/personal-memory/index.ts";
import {
  memoryScopeConstraints,
  memorySpaceId,
} from "../authoring/scopes/index.ts";
import { ensureWritableMemorySpace } from "./access.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ??
  Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL") ?? ":memory:";
const backend = url === ":memory:" ? "PGlite" : "PostgreSQL";
Deno.test(`${backend}: unified scopes, parallel append, migration, privacy and moving threads`, async () => {
  const db = await createTestDatabase({ url });
  const registry = await createPluginRegistry({
    plugins: [memoryPlugin],
    resources: { memory: { config: { enabled: false } } },
  });
  const engine = await createCopilotzEngine({
    session: db,
    registry,
    defaultDatabaseSchema: `memory_scopes_${
      crypto.randomUUID().replaceAll("-", "")
    }`,
  });
  const context = createTestDomainContext(engine, "tenant");
  const c = context.collections;
  const meta = (
    threadId = "a",
    initiatorParticipantId = "alice",
    agentId = "agent-a",
  ) => ({ metadata: { threadId, initiatorParticipantId, agentId } });
  const remember = (
    text: string,
    scope = "thread",
    thread = "a",
    human = "alice",
  ) =>
    context.actions.remember({ text, scope }, meta(thread, human)) as Promise<
      { id: string }
    >;
  const search = async (
    thread = "a",
    human = "alice",
    includeRetired = false,
  ) =>
    await context.actions.search_memory(
      { includeRetired },
      meta(thread, human, "agent-b"),
    ) as { notes: { id: string; text: string; state: string }[] };
  const promptInput = (thread = "a", human = "alice") => ({
    context,
    collections: c,
    thread: { id: thread },
    initiatorParticipantId: human,
    agent: { id: "agent-b" },
    participant: { id: "agent-b" },
    signal: new AbortController().signal,
    purpose: "conversation",
  });
  try {
    for (const id of ["alice", "bob"]) {
      await c.participant.create({
        id,
        externalId: id,
        participantType: "human",
        ...(id === "alice"
          ? {
            metadata: {
              memories: {
                items: [{
                  id: "old",
                  content: "Legacy preference",
                  category: "preference",
                }],
              },
            },
          }
          : {}),
      });
    }
    await c.participant.create({
      id: "agent-a",
      externalId: "agent-a",
      participantType: "agent",
    });
    for (const id of ["a", "b", "shared"]) {
      await c.thread.create({
        id,
        participantIds: id === "shared"
          ? ["alice", "bob", "agent-a"]
          : ["alice", "agent-a"],
      });
    }
    for (const id of ["one", "two"]) {
      await context.actions.spaces({
        operation: "create",
        spaceId: id,
        ownerId: "alice",
      });
    }
    const [first, second] = await Promise.all([
      remember("parallel first", "personal"),
      remember("parallel second", "personal"),
    ]);
    assert(first.id !== second.id);
    const own = await search();
    assertEquals(own.notes.length, 3);
    assert(own.notes.some((note) => note.text === "Legacy preference"));
    assertEquals((await search("b")).notes, own.notes);
    assertEquals((await search("a", "bob")).notes, []);
    assertEquals((await search("a", "agent-a")).notes, []);
    assertEquals((await search("a", "")).notes, []);
    await assertRejects(
      () => remember("invalid", "personal", "a", "agent-a"),
      Error,
      "human initiator",
    );
    const legacy = own.notes.find((note) => note.text === "Legacy preference")!;
    await context.actions.personal_memory({
      operation: "retire",
      id: legacy.id,
    }, { metadata: { initiatorParticipantId: "alice" } });
    await context.actions.personal_memory({ operation: "import" }, {
      metadata: { initiatorParticipantId: "alice" },
    });
    assert(!(await search()).notes.some((note) => note.id === legacy.id));
    assertEquals((await search("a", "alice", true)).notes.length, 3);
    assertEquals(
      ((await c.participant.get({ id: "alice" }))!.metadata as {
        memories: { items: unknown[] };
      }).memories.items.length,
      1,
    );
    await assertRejects(() =>
      context.actions.personal_memory({ operation: "retire", id: first.id }, {
        metadata: { initiatorParticipantId: "bob" },
      })
    );
    await assertRejects(
      () =>
        context.actions.retire_memory(
          { id: first.id, reason: "no" },
          meta("a", "bob"),
        ),
      Error,
      "unavailable",
    );
    const corrected = await context.actions.remember({
      text: "Corrected preference",
      scope: "personal",
      replaces: first.id,
    }, meta()) as { id: string };
    assert(!(await search()).notes.some((note) => note.id === first.id));
    assert((await search()).notes.some((note) => note.id === corrected.id));
    const before = (await c.memoryNote.list()).length;
    await assertRejects(() =>
      context.actions.remember({
        text: "must roll back",
        scope: "thread",
        replaces: corrected.id,
      }, meta())
    );
    assertEquals((await c.memoryNote.list()).length, before);
    await personalMemoryContext.prepare!(
      { context, threadId: "a", initiatorParticipantId: "alice" } as never,
    );
    const block = await personalMemoryContext.contribute(
      promptInput() as never,
    );
    assertStringIncludes(JSON.stringify(block), "Corrected preference");
    assertEquals(
      block,
      await personalMemoryContext.contribute(promptInput("b") as never),
    );
    assertEquals(
      block,
      await personalMemoryContext.contribute(promptInput() as never),
    );
    assertEquals(
      await personalMemoryContext.contribute(promptInput("shared") as never),
      null,
    );
    assertEquals(
      await personalMemoryContext.contribute(
        promptInput("a", "bob") as never,
      ),
      null,
    );
    assertEquals((await search("shared")).notes.length, 2);
    const local = await remember("thread only");
    await ensureWritableMemorySpace(context as never, "a");
    assert(
      await c.memorySpaceAccess.get({
        id: `memory-space-access:a:${memorySpaceId("thread", "a")}`,
      }),
    );
    const attach = (thread: string, spaceId: string) =>
      context.actions.spaces({
        operation: "attach",
        spaceId,
        collection: "thread",
        recordId: thread,
      });
    await attach("a", "one");
    await attach("b", "one");
    const common = await remember("Shared project fact", "space");
    assert((await search("b")).notes.some((note) => note.id === common.id));
    const queried = await context.actions.search_memory({
      query: "Shared project",
    }, meta("b")) as { notes: { id: string }[] };
    assert(queried.notes.some((note) => note.id === common.id));
    assert(!(await search("b")).notes.some((note) => note.id === local.id));
    const inspected = await context.actions.inspect_memory({
      ids: [common.id, local.id, corrected.id],
    }, meta("b", "bob")) as {
      notes: { id: string }[];
      unavailableIds: string[];
    };
    assertEquals(inspected.notes.map((n) => n.id), [common.id]);
    assertEquals(inspected.unavailableIds, [local.id, corrected.id]);
    const read = {
      get: (alias: string, id: string) => c[alias].get({ id }),
      list: (alias: string) => c[alias].list(),
    };
    const constraints = await memoryScopeConstraints(read, {
      threadId: "b",
      initiatorParticipantId: "bob",
    });
    const visible = await c.memoryNote.list(
      constraints.collections!.memoryNote,
    );
    assertEquals(visible.map((n) => n.id), [common.id]);
    await attach("b", "two");
    assert(!(await search("b")).notes.some((note) => note.id === common.id));
    const moved = await memoryScopeConstraints(read, {
      threadId: "b",
      initiatorParticipantId: "bob",
    });
    assertEquals(await c.memoryNote.list(moved.collections!.memoryNote), []);
    await attach("b", "one");
    assert((await search("b")).notes.some((note) => note.id === common.id));
    await context.actions.spaces({
      operation: "detach",
      spaceId: "one",
      collection: "thread",
      recordId: "b",
    });
    assert(!(await search("b")).notes.some((note) => note.id === common.id));
    await context.actions.spaces({ operation: "archive", spaceId: "one" });
    assert(!(await search()).notes.some((note) => note.id === common.id));
    await assertRejects(() => remember("unavailable", "space"));
    // Even explicit legacy grants cannot authorize another person's or thread's scope.
    await c.memorySpaceAccess.create({
      id: "bad-grant",
      threadId: "b",
      memorySpaceId: memorySpaceId("personal", "alice"),
      access: "read_write",
      defaultWrite: false,
    });
    assertEquals((await search("b", "bob")).notes, []);
    await Promise.all(
      Array.from(
        { length: 24 },
        (_, i) =>
          remember(`Bounded item ${i}: ` + "x".repeat(2500), "personal"),
      ),
    );
    const bounded = await personalMemoryContext.contribute(
      promptInput() as never,
    ) as { content: { text: string } };
    assert(bounded.content.text.length <= 8000);
    assert(bounded.content.text.split("\n- ").length - 1 <= 20);
  } finally {
    await engine.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${engine.databaseSchema}" CASCADE`);
    await db.close();
  }
});
Deno.test(`${backend}: owner policies constrain direct collection reads and writes`, async () => {
  const db = await createTestDatabase({ url });
  const registry = await createPluginRegistry({
    plugins: [memoryPlugin],
    resources: { memory: { config: { enabled: false } } },
  });
  const engine = await createCopilotzEngine({
    session: db,
    registry,
    defaultDatabaseSchema: `memory_policy_${
      crypto.randomUUID().replaceAll("-", "")
    }`,
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: ["thread", "space", "participant"],
          evaluate: ({ read, authority }) =>
            memoryScopeConstraints(read, {
              threadId: authority.scope.bindings.threadId,
              initiatorParticipantId: authority.principal.id,
            }),
        },
      },
      collections: Object.fromEntries(
        ["memoryNote", "memorySpace", "memorySpaceAccess", "longTermMemory"]
          .map((key) => [key, { id: "fixture", revision: "1" }]),
      ),
      actions: {},
    },
  });
  const c = engine.collections.withScope({ namespace: "tenant" });
  const asTurn = <T>(
    human: string,
    threadId: string,
    run: () => Promise<T>,
  ) => {
    const authority = testAuthority(engine.databaseSchema, "tenant", human);
    return withRetainedAuthority(
      { ...authority, scope: { ...authority.scope, bindings: { threadId } } },
      new AbortController().signal,
      run,
    );
  };
  const note = (id: string, memorySpaceId: string) => ({
    id,
    text: id,
    memorySpaceId,
    consolidationId: null,
    createdByAgentId: "agent",
    originThreadId: "a",
    sources: [],
    retirement: null,
  });
  try {
    for (const id of ["alice", "bob"]) {
      await c.participant.create({
        id,
        externalId: id,
        participantType: "human",
      });
    }
    await c.space.create({ id: "one", ownerId: "alice", status: "active" });
    for (const id of ["a", "b"]) {
      await c.thread.create({ id, spaceId: "one" });
    }
    const own = memorySpaceId("personal", "alice"),
      common = memorySpaceId("space", "one");
    await asTurn(
      "alice",
      "a",
      () =>
        c.memory_space.create({
          id: own,
          scopeType: "personal",
          scopeId: "alice",
        }),
    );
    await asTurn(
      "alice",
      "a",
      () =>
        c.memory_space.create({
          id: common,
          scopeType: "space",
          scopeId: "one",
        }),
    );
    await asTurn(
      "alice",
      "a",
      () => c.memory_note.create(note("private", own)),
    );
    await asTurn(
      "alice",
      "a",
      () => c.memory_note.create(note("shared", common)),
    );
    await assertRejects(() =>
      asTurn("bob", "b", () => c.memory_note.get({ id: "private" }))
    );
    assertEquals(
      (await asTurn("alice", "b", () => c.memory_note.list())).map((n) => n.id),
      ["private", "shared"],
    );
    assertEquals(
      (await asTurn("bob", "b", () => c.memory_note.list())).map((n) => n.id),
      ["shared"],
    );
    await assertRejects(() =>
      asTurn("bob", "b", () => c.memory_note.create(note("forged", own)))
    );
    await assertRejects(() =>
      asTurn(
        "bob",
        "b",
        () =>
          c.memory_note.commands.retire({
            id: "private",
            memorySpaceId: own,
            retirement: {
              checkpointId: "forged",
              retiredAt: new Date().toISOString(),
              retiredBy: "bob",
              reason: "forbidden",
            },
          }),
      )
    );
    await asTurn(
      "alice",
      "b",
      () => c.memory_note.create(note("allowed", own)),
    );
    await c.thread.update({ id: "b", unset: ["spaceId"] });
    assertEquals(await asTurn("bob", "b", () => c.memory_note.list()), []);
    await assertRejects(() =>
      asTurn("bob", "b", () => c.memory_note.create(note("detached", common)))
    );
    await assertRejects(() =>
      asTurn(
        "alice",
        "b",
        () =>
          c.memory_note.update({ id: "private", set: { text: "rewritten" } }),
      )
    );
    await assertRejects(() =>
      asTurn("alice", "b", () => c.memory_note.delete({ id: "private" }))
    );
  } finally {
    await engine.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${engine.databaseSchema}" CASCADE`);
    await db.close();
  }
});
