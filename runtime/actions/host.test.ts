import { assertEquals } from "@std/assert";
import type { CollectionRuntime } from "../collections/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import { createActionContext } from "./host.ts";
import type { ActionContext } from "./types.ts";

Deno.test("Action transactions expose atomic relation projection", async () => {
  const projected: unknown[] = [];
  let transactionIdentity: unknown;
  const upsertRelation = defineAction({
    id: "test.relation.upsert",
    execute(
      input: Readonly<{ from: string; to: string }>,
      context: ActionContext,
    ) {
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
  const collectionRuntime = {
    withScope: () => Object.freeze({}),
    async transaction<T>(options: {
      operationKey: string;
      namespace: string;
      identity?: unknown;
      execute(): Promise<T>;
    }) {
      transactionIdentity = options.identity;
      return {
        value: await options.execute(),
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
    plugins,
    collectionRuntime,
    actionLifecycle: {
      append: () => Promise.resolve(undefined as never),
      load: () => Promise.resolve(null),
    },
    contentResolver: { getMany: () => Promise.resolve([]) },
    events: { list: () => Promise.resolve([]) },
    deliveries: { list: () => Promise.resolve([]) },
    relations: {
      list: () => Promise.resolve([]),
      upsert(input) {
        projected.push(input);
        return Promise.resolve({
          ...input,
          metadata: input.metadata ?? {},
          weight: input.weight ?? 1,
          createdAt: new Date(0).toISOString(),
        });
      },
    },
  });

  const result = await context.actions.upsertRelation({
    from: "memory-a",
    to: "memory-b",
  }, {
    identity: {
      causationId: "event-a",
      correlationId: "run-a",
      deduplicationId: "delivery-a",
      settlementScopeId: "scope-a",
    },
  });

  assertEquals(projected, [{
    namespace: "tenant-actions",
    id: "memory-a:related:memory-b",
    type: "test.link",
    source: { type: "memory_record", id: "memory-a" },
    target: { type: "memory_record", id: "memory-b" },
  }]);
  assertEquals(result, {
    namespace: "tenant-actions",
    id: "memory-a:related:memory-b",
    type: "test.link",
    source: { type: "memory_record", id: "memory-a" },
    target: { type: "memory_record", id: "memory-b" },
    metadata: {},
    weight: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  assertEquals(transactionIdentity, {
    causationId: "event-a",
    correlationId: "run-a",
    settlementScopeId: "scope-a",
  });
});
