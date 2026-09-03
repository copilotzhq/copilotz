import { assertEquals, assertExists } from "@std/assert";
import type { CollectionRuntime } from "../collections/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import { createActionContext } from "./host.ts";
import type { ActionContext, ActionEventData } from "./types.ts";
import type {
  ContentStreamOpenInput,
  ContentStreamRuntime,
} from "../streams/index.ts";

Deno.test("Action transactions expose atomic relation projection", async () => {
  const projected: unknown[] = [];
  const lifecycleData: ActionEventData[] = [];
  let transactionIdentity: unknown;
  let actionMetadata: ActionContext["action"]["metadata"] | undefined;
  const upsertRelation = defineAction({
    id: "test.relation.upsert",
    execute(
      input: Readonly<{ from: string; to: string }>,
      context: ActionContext,
    ) {
      actionMetadata = context.action.metadata;
      return context.transaction((transaction) =>
        transaction.relations.upsert({
          id: "memory-a:related:memory-b",
          type: "test.link",
          source: { type: "memory_record", id: input.from },
          target: { type: "memory_record", id: input.to },
        })
      );
    },
  });
  const plugins = createPluginRegistry({
    plugins: [definePlugin({
      id: "test.actions",
      version: "1.0.0",
      actions: { upsertRelation },
    })],
  });
  const collections = {
    withScope: () => Object.freeze({}),
    async transaction<T>(options: {
      operationKey: string;
      namespace: string;
      identity?: unknown;
      execute(
        context: Readonly<{
          collections: Record<string, never>;
          relations: Readonly<{
            upsert(
              input: Readonly<Record<string, unknown> & { id: string }>,
            ): Promise<Readonly<{ id: string }>>;
          }>;
        }>,
      ): Promise<T>;
    }) {
      transactionIdentity = options.identity;
      const relations = Object.freeze({
        upsert(input: Readonly<Record<string, unknown> & { id: string }>) {
          projected.push(input);
          return Promise.resolve(Object.freeze({ id: input.id }));
        },
      });
      return {
        value: await options.execute({ collections: {}, relations }),
        operationKey: options.operationKey,
        namespace: options.namespace,
        settlementScopeId: "settlement-test",
        correlationId: "correlation-test",
        writes: [],
        dispatch: {},
      };
    },
  } as unknown as CollectionRuntime;
  const context = createActionContext({
    namespace: "tenant-actions",
    databaseSchema: "copilotz_action_host",
    plugins,
    collections,
    actionLifecycle: {
      append({ data }) {
        lifecycleData.push(data);
        return Promise.resolve(undefined as never);
      },
      load: () => Promise.resolve(null),
    },
    content: () =>
      Object.freeze({
        resolver: { getMany: () => Promise.resolve([]) },
        stream: Object.freeze({
          open() {
            throw new Error("Content streams are not configured.");
          },
          follow() {
            throw new Error("Content streams are not configured.");
          },
        }),
        prepare() {
          throw new Error("Content is not configured.");
        },
        materialize() {
          throw new Error("Content is not configured.");
        },
        publish() {
          throw new Error("Content is not configured.");
        },
        get() {
          throw new Error("Content is not configured.");
        },
        getMany() {
          throw new Error("Content is not configured.");
        },
        resolve() {
          throw new Error("Content is not configured.");
        },
        resolveMany() {
          throw new Error("Content is not configured.");
        },
        open() {
          throw new Error("Content is not configured.");
        },
      }),
  });

  const invocationMetadata = { trace: { tags: ["initial"] } };
  const resultPromise = context.actions.upsertRelation({
    from: "memory-a",
    to: "memory-b",
  }, {
    metadata: invocationMetadata,
    identity: {
      causationId: "event-a",
      correlationId: "run-a",
      deduplicationId: "delivery-a",
      settlementScopeId: "scope-a",
    },
  });
  invocationMetadata.trace.tags.push("mutated-after-call");
  const result = await resultPromise;

  assertEquals(projected, [{
    id: "memory-a:related:memory-b",
    type: "test.link",
    source: { type: "memory_record", id: "memory-a" },
    target: { type: "memory_record", id: "memory-b" },
  }]);
  assertEquals(result, { id: "memory-a:related:memory-b" });
  assertEquals(actionMetadata, { trace: { tags: ["initial"] } });
  assertEquals(Object.isFrozen(actionMetadata), true);
  assertEquals(Object.isFrozen(actionMetadata?.trace), true);
  assertEquals(
    lifecycleData.map((event) => event.metadata),
    [
      { trace: { tags: ["initial"] } },
      { trace: { tags: ["initial"] } },
    ],
  );
  assertEquals(transactionIdentity, {
    causationId: "event-a",
    correlationId: "run-a",
    settlementScopeId: "scope-a",
  });
});

Deno.test("Action streams carry their exact root and nested action run IDs", async () => {
  const opened: ContentStreamOpenInput[] = [];
  const actionRunIds: { root?: string; nested?: string } = {};
  const streams: ContentStreamRuntime = Object.freeze({
    open(input) {
      opened.push(structuredClone(input));
      return Promise.resolve(
        {} as Awaited<ReturnType<ContentStreamRuntime["open"]>>,
      );
    },
    follow() {
      throw new Error("Content stream following is not configured.");
    },
  });
  const nested = defineAction({
    id: "test.stream.nested",
    async execute(_input: unknown, context: ActionContext) {
      actionRunIds.nested = context.action.runId;
      await context.streams.open({
        id: "nested-stream",
        mediaType: "text/plain",
        role: "output",
        metadata: { source: "nested" },
      });
    },
  });
  type RootActionContext =
    & Omit<ActionContext, "actions">
    & Readonly<{
      actions: Readonly<{
        nested: (input: unknown) => Promise<unknown>;
      }>;
    }>;
  const root = defineAction<unknown, void, RootActionContext>({
    id: "test.stream.root",
    async execute(_input, context) {
      actionRunIds.root = context.action.runId;
      await context.streams.open({
        id: "root-stream",
        mediaType: "text/plain",
        role: "output",
        metadata: {
          source: "root",
          sourceActionRunId: "caller-controlled-value",
        },
      });
      await context.actions.nested({});
    },
  });
  const plugins = createPluginRegistry({
    plugins: [definePlugin({
      id: "test.action-stream-provenance",
      version: "1.0.0",
      actions: { root, nested },
    })],
  });
  const unavailableContent = () => {
    throw new Error("Content is not configured.");
  };
  const context = createActionContext({
    namespace: "tenant-streams",
    databaseSchema: "copilotz_action_streams",
    plugins,
    collections: {
      withScope: () => Object.freeze({}),
    } as unknown as CollectionRuntime,
    actionLifecycle: {
      append: () => Promise.resolve(undefined as never),
      load: () => Promise.resolve(null),
    },
    content: () =>
      Object.freeze({
        resolver: { getMany: () => Promise.resolve([]) },
        stream: streams,
        prepare: unavailableContent,
        materialize: unavailableContent,
        publish: unavailableContent,
        get: unavailableContent,
        getMany: unavailableContent,
        resolve: unavailableContent,
        resolveMany: unavailableContent,
        open: unavailableContent,
      }),
  });

  await context.actions.root({});

  assertExists(actionRunIds.root);
  assertExists(actionRunIds.nested);
  assertEquals(actionRunIds.root === actionRunIds.nested, false);
  assertEquals(opened.map((input) => input.metadata), [
    { source: "root", sourceActionRunId: actionRunIds.root },
    { source: "nested", sourceActionRunId: actionRunIds.nested },
  ]);
});
