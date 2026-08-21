import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  activeCollectionTransaction,
  createCollectionRuntime,
  defineCollection,
} from "../collections/index.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createAdminPlugin } from "../admin/plugin.ts";
import { coreFeatureAliases } from "@copilotz/copilotz/plugins/core";
import {
  createFeatureContext,
  defineFeature,
  type FeatureExecuteContext,
  isFeatureDefinition,
} from "./index.ts";

const NOW = "2026-08-20T12:00:00.000Z";
const NAMESPACE = "tenant-features";

const noteCollection = defineCollection({
  name: "note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "title", "createdAt", "updatedAt"],
  } as const,
});

const idInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
  },
  required: ["id", "title"],
} as const;

const noteOutput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
  },
  required: ["id", "title"],
} as const;

Deno.test("defineFeature accepts code-first actions and rejects old action contracts", () => {
  const feature = defineFeature({
    id: "test.simple",
    actions: {
      ping: () => ({ ok: true }),
      create: {
        inputSchema: idInput,
        outputSchema: noteOutput,
        execute(input) {
          return input;
        },
      },
    },
  });
  assertEquals(isFeatureDefinition(feature), true);
  assertEquals("inputSchema" in feature.actions.ping, false);
  assertEquals(typeof feature.actions.ping.execute, "function");

  for (
    const [field, message] of [
      ["effect", "cannot declare effect"],
      ["requires", "cannot declare requires"],
      ["content", "cannot declare content fields"],
    ] as const
  ) {
    assertThrows(
      () =>
        defineFeature({
          id: `test.old-${field}`,
          actions: {
            run: {
              inputSchema: { type: "object" },
              [field]: field === "effect" ? "query" : {},
              execute: () => undefined,
            },
          },
        } as never),
      TypeError,
      message,
    );
  }

  assertThrows(
    () =>
      defineFeature({
        id: "test.legacy",
        alias: "legacy",
        actions: { run: () => undefined },
      } as never),
    TypeError,
    "cannot declare alias",
  );
  assertEquals(
    isFeatureDefinition({
      id: "x",
      actions: {
        run: {
          inputSchema: { type: "object" },
          effect: "query",
          execute: () => {},
        },
      },
    }),
    false,
  );
  assertThrows(
    () =>
      defineFeature({
        id: "test.old-schema-name",
        actions: {
          run: { input: { type: "object" }, execute: () => undefined },
        },
      } as never),
    TypeError,
    "Use inputSchema",
  );
});

Deno.test("core and admin features use the code-first descriptor shape", () => {
  for (const [alias, feature] of Object.entries(coreFeatureAliases)) {
    assertEquals(isFeatureDefinition(feature), true, alias);
    assertEquals("alias" in feature, false, alias);
    assertEquals("mode" in feature, false, alias);
    for (const action of Object.values(feature.actions)) {
      assertEquals("effect" in action, false, alias);
      assertEquals("requires" in action, false, alias);
      assertEquals("content" in action, false, alias);
    }
  }

  const admin = createAdminPlugin().resources.features?.[0];
  assert(admin);
  assertEquals(isFeatureDefinition(admin), true);
});

Deno.test("feature context validates optional schemas and runs explicit transactions", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_feature_context";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const processor = defineProcessor({
    id: "note.audit",
    on: [{ eventType: "note.created" }],
    handle: () => undefined,
  });
  const searchTool = Object.freeze({
    id: "provider-search",
    key: "provider-search",
    name: "Search",
    description: "Search test notes.",
  });
  const customAdapter = Object.freeze({ id: "adapter-a" });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.feature-context",
      version: "1.0.0",
      processors: [processor],
      collections: [noteCollection],
      context: {
        tools: { search: searchTool },
        customAdapters: { primary: customAdapter },
      },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "feature-context-test",
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    createId: () => `fx-${++nextId}`,
    now: () => new Date(NOW),
  });
  runtime.bind(noteCollection);

  const seen = {
    activeBefore: false,
    activeInside: false,
    activeAfter: false,
    operationKeys: [] as string[],
    signal: undefined as AbortSignal | undefined,
  };

  const writer = defineFeature({
    id: "test.note-writer",
    actions: {
      create: {
        inputSchema: idInput,
        outputSchema: noteOutput,
        async execute(input, context: FeatureExecuteContext) {
          const data = input as { id: string; title: string };
          seen.activeBefore = activeCollectionTransaction(runtime) !==
            undefined;
          seen.operationKeys.push(context.operationKey ?? "");
          const record = await context.transaction(async (tx) => {
            seen.activeInside = activeCollectionTransaction(runtime) !==
              undefined;
            return await tx.collection(noteCollection).create({
              id: data.id,
              title: data.title,
            });
          }, { operationKey: "write-note" });
          seen.activeAfter = activeCollectionTransaction(runtime) !== undefined;
          return record;
        },
      },
      passthrough(input) {
        return input;
      },
      badOutput: {
        outputSchema: noteOutput,
        execute() {
          return { id: "missing-title" };
        },
      },
      signal(_input, context: FeatureExecuteContext) {
        seen.signal = context.signal;
        assertEquals(context.tools.search, searchTool);
        assertEquals(
          ((context as unknown as {
            customAdapters: Record<string, unknown>;
          }).customAdapters).primary,
          customAdapter,
        );
        assertEquals("resource" in context, false);
        return { ok: true };
      },
    },
  });

  const context = createFeatureContext({
    namespace: NAMESPACE,
    plugins: registry,
    collectionRuntime: runtime,
    contentResolver: { getMany: async () => [] },
    events: { list: async () => [] },
    deliveries: { list: async () => [] },
    relations: { list: async () => [] },
  });
  const actions = context.feature(writer);

  const created = await actions.create(
    { id: "note-1", title: "hello" },
    { operationKey: "root-key" },
  );
  assertEquals(created.id, "note-1");
  assertEquals(created.title, "hello");
  assertEquals(seen.activeBefore, false);
  assertEquals(seen.activeInside, true);
  assertEquals(seen.activeAfter, false);
  assertEquals(
    seen.operationKeys[0],
    "root-key/feature:test.note-writer:create",
  );
  assertEquals(
    await context.collection(noteCollection).get({ id: "note-1" }),
    created,
  );

  assertEquals(await actions.passthrough("raw"), "raw");
  await assertRejects(
    () => actions.create({ id: "missing-title" } as never),
    Error,
    "Feature 'test.note-writer' action 'create' input",
  );
  await assertRejects(
    () => actions.badOutput({}),
    Error,
    "Feature 'test.note-writer' action 'badOutput' output",
  );

  const controller = new AbortController();
  await actions.signal({}, { signal: controller.signal });
  assertEquals(seen.signal, controller.signal);
});
