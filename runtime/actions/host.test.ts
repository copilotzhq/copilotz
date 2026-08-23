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
    plugins,
    collections,
    actionLifecycle: {
      append: () => Promise.resolve(undefined as never),
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
    id: "memory-a:related:memory-b",
    type: "test.link",
    source: { type: "memory_record", id: "memory-a" },
    target: { type: "memory_record", id: "memory-b" },
  }]);
  assertEquals(result, { id: "memory-a:related:memory-b" });
  assertEquals(transactionIdentity, {
    causationId: "event-a",
    correlationId: "run-a",
    settlementScopeId: "scope-a",
  });
});
