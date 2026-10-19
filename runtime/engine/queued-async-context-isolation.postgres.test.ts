import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import { validateCollectionProjections } from "../collections/projection-registration.ts";
import { defineCollection } from "../collections/definition.ts";
import { joinCollectionRuntime } from "../collections/joined-runtime.ts";
import { createCollectionRuntime } from "../collections/kernel.ts";
import { withOwnerCollectionInvocation } from "../collections/policy-invocation.ts";
import { validateCollectionPolicies } from "../collections/policy-registration.ts";
import {
  currentCollectionReadBudget,
  queryCollectionRows,
  withCollectionReadBudget,
} from "../collections/read-budget.ts";
import { readViews } from "../collections/read-view.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { bounded, localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const record = defineCollection({
  name: "boundary_record",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  } as const,
});

async function fixture() {
  const db = await createTestDatabase({
    url: localPostgresUrl(url!),
    pgPoolMax: 4,
  });
  const schema = `async_boundary_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    flushCommitted: () => Promise.resolve({ handles: [], failures: [] }),
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const runtime = createCollectionRuntime({
    session: db,
    eventStore: store,
    coordinator,
  });
  runtime.bind(record);
  return {
    db,
    schema,
    owner,
    store,
    coordinator,
    runtime,
    caller: { principal: "fixture", epoch: owner.epoch! },
    async close() {
      releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "queued B preserves its own mutable cumulative read budget and hop view; publication starts clean",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    let aBudget: ReturnType<typeof currentCollectionReadBudget>;
    let bBudget: ReturnType<typeof currentCollectionReadBudget>;
    const value = "1234567890";
    const rows = [{ value }];
    const bytes = new TextEncoder().encode(JSON.stringify(rows)).length;
    const sql = "SELECT '1234567890'::text AS value";
    const held = f.owner.register("boundary.a", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const next = f.owner.register("boundary.b", {
      authorize() {},
      async execute(_input: unknown, command) {
        await ended.promise;
        assertStrictEquals(currentCollectionReadBudget(), bBudget);
        assertEquals(bBudget!.maxResultBytes, 100 - bytes);
        assertEquals(readViews.memo()?.recall("same-key"), { value: "B" });
        assertEquals(
          await queryCollectionRows(command.transaction, sql, []),
          rows,
        );
        const joined = createSchemaCommandRunner(command.transaction, f.schema);
        await joined("boundary.nested", {}, async () => {
          assertStrictEquals(currentCollectionReadBudget(), bBudget);
          assertEquals(readViews.memo()?.recall("same-key"), { value: "B" });
          assertEquals(
            await queryCollectionRows(command.transaction, sql, []),
            rows,
          );
          assertEquals(
            await queryCollectionRows(command.transaction, sql, []),
            rows,
          );
          await assertRejects(
            () => queryCollectionRows(command.transaction, sql, []),
            RangeError,
            "transfer budget",
          );
          // Explicit child budgets retain their existing independent limits.
          await withCollectionReadBudget(async () => {
            assertEquals(currentCollectionReadBudget() === bBudget, false);
            assertEquals(
              await queryCollectionRows(command.transaction, sql, []),
              rows,
            );
          });
          assertStrictEquals(currentCollectionReadBudget(), bBudget);
        });
        assertEquals(bBudget!.maxResultBytes, 100 - 4 * bytes);
        assertEquals(aBudget!.maxResultBytes, 1);
        command.afterCommit(async () => {
          try {
            assertEquals(currentCollectionReadBudget(), undefined);
            assertEquals(readViews.memo(), undefined);
            await withCollectionReadBudget(async () => {
              const callbackBudget = currentCollectionReadBudget();
              assertEquals(await queryCollectionRows(f.db, sql, []), rows);
              assertStrictEquals(currentCollectionReadBudget(), callbackBudget);
            });
            published.resolve();
          } catch (error) {
            published.reject(error);
          }
        });
      },
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = readViews.run(() =>
        withCollectionReadBudget(async () => {
          aBudget = currentCollectionReadBudget();
          (aBudget as { maxResultBytes: number }).maxResultBytes = 1;
          readViews.memo()!.begin(["same-key"]).remember("same-key", "A");
          await held(f.caller, { input: {} });
        })
      ).then(() => ended.resolve());
      await bounded(entered.promise, "A holds queue with exhausted read state");
      second = readViews.run(() =>
        withCollectionReadBudget(async () => {
          bBudget = currentCollectionReadBudget();
          Object.assign(bBudget!, { maxRowBytes: 100, maxResultBytes: 100 });
          readViews.memo()!.begin(["same-key"]).remember("same-key", "B");
          assertEquals(await queryCollectionRows(f.db, sql, []), rows);
          const pending = next(f.caller, { input: {} });
          admitted.resolve();
          await pending;
        })
      );
      void second.catch(() => undefined);
      await bounded(
        admitted.promise,
        "B captured its partially consumed budget",
      );
      release.resolve();
      await bounded(
        Promise.all([first, second]),
        "B keeps its own cumulative scope",
      );
      await bounded(
        published.promise,
        "independent publication drops old scope",
      );
    } finally {
      release.resolve();
      ended.resolve();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await f.close();
    }
  },
});

Deno.test({
  name: "queued unscoped B does not inherit A's exhausted read budget or memo",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = f.owner.register("boundary.unscoped-a", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const next = f.owner.register("boundary.unscoped-b", {
      authorize() {},
      async execute(_input: unknown, command) {
        assertEquals(currentCollectionReadBudget(), undefined);
        assertEquals(readViews.memo(), undefined);
        assertEquals(
          await queryCollectionRows(
            command.transaction,
            "SELECT 1 AS value",
            [],
          ),
          [{ value: 1 }],
        );
      },
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = readViews.run(() =>
        withCollectionReadBudget(async () => {
          Object.assign(currentCollectionReadBudget()!, { maxResultBytes: 1 });
          readViews.memo()!.begin(["only-a"]).remember("only-a", "A");
          await held(f.caller, { input: {} });
        })
      );
      await bounded(entered.promise, "scoped A holds owner");
      second = next(f.caller, { input: {} });
      release.resolve();
      await bounded(Promise.all([first, second]), "unscoped B stays unscoped");
    } finally {
      release.resolve();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await f.close();
    }
  },
});

Deno.test({
  name:
    "independent same-kernel publication starts a new disclosure and runs B policy after A ends",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const guarded = defineCollection({
      name: "boundary_guarded",
      ownerPolicy: "required",
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      } as const,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const seen: string[] = [];
    const runtime = createCollectionRuntime({
      session: f.db,
      eventStore: f.store,
      coordinator: f.coordinator,
      policies: validateCollectionPolicies({
        guarded: {
          async authorize(intent, context) {
            seen.push(`${context.invocation.id}:${intent.phase}`);
            if (context.invocation.id === "a" && intent.phase === "read") {
              entered.resolve();
              await release.promise;
            }
          },
        },
      }, { guarded }),
    });
    runtime.bind(guarded);
    const authority = (id: string) => ({
      scope: { databaseSchema: f.schema, namespace: "space" },
      invocation: { kind: "processor" as const, id, runId: id },
      signal: new AbortController().signal,
      check() {},
      resolveSource(): Promise<never> {
        throw new Error("unused");
      },
    });
    const next = f.owner.register("boundary.publish-b", {
      authorize() {},
      execute(_input: unknown, command) {
        command.afterCommit(async () => {
          try {
            await ended.promise;
            assertEquals(
              await withOwnerCollectionInvocation(
                authority("b"),
                () =>
                  runtime.withScope({ namespace: "space" }).boundary_guarded
                    .get({
                      id: "missing",
                    }),
              ),
              null,
            );
            assertEquals(seen.filter((item) => item.startsWith("b:")), [
              "b:read",
              "b:result",
              "b:result",
            ]);
            published.resolve();
          } catch (error) {
            published.reject(error);
          }
        });
      },
    });
    let first: Promise<unknown> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = withOwnerCollectionInvocation(
        authority("a"),
        () =>
          runtime.withScope({ namespace: "space" }).boundary_guarded.get({
            id: "missing",
          }),
      ).then(() => ended.resolve());
      await bounded(entered.promise, "A protected read seeds owner drain");
      second = next(f.caller, { input: {} });
      release.resolve();
      await bounded(
        Promise.all([first, second, published.promise]),
        "B reads under its own disclosure",
      );
    } finally {
      release.resolve();
      ended.resolve();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await f.close();
    }
  },
});

Deno.test({
  name:
    "independent command drops source snapshot context while retained snapshot getters stay revoked",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retained!: () => Promise<unknown>;
    const held = f.owner.register("boundary.snapshot-a", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const next = f.owner.register("boundary.snapshot-b", {
      authorize() {},
      async execute(_input: unknown, command) {
        assertEquals(
          await f.runtime.withScope({ namespace: "space" }).boundary_record.get(
            { id: "missing" },
          ),
          null,
        );
        await assertRejects(
          retained,
          Error,
          "Read snapshot access has already closed",
        );
        const joined = joinCollectionRuntime(
          f.runtime,
          { records: record },
          command,
        );
        try {
          await joined.runtime.transaction({
            namespace: "space",
            operationKey: "fresh-joined",
            async execute({ collections }) {
              await collections.boundary_record.create({ id: "b" });
            },
          });
        } finally {
          joined.close();
        }
      },
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await f.runtime.readSnapshot(
        { namespace: "space" },
        async ({ collections }) => {
          retained = () => collections.boundary_record.get({ id: "missing" });
          first = held(f.caller, { input: {} });
          await bounded(entered.promise, "A snapshot seeds drain");
        },
      );
      second = next(f.caller, { input: {} });
      release.resolve();
      await bounded(
        Promise.all([first, second]),
        "B ignores unrelated closed snapshot",
      );
      assertEquals(
        (await f.db.query(
          `SELECT id FROM "${f.schema}".nodes WHERE type='boundary_record'`,
        )).rows,
        [{ id: "b" }],
      );
    } finally {
      release.resolve();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await f.close();
    }
  },
});

for (const denyFinal of [false, true]) {
  Deno.test({
    name: `queued named read preserves nested disclosure aggregation ${
      denyFinal ? "through final denial" : "through final authorization"
    }`,
    ignore: !url,
    async fn() {
      const f = await fixture();
      let allowed = true;
      const phases: string[] = [];
      const child = defineCollection({
        name: "disclosure_child",
        ownerPolicy: "required",
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        } as const,
      });
      const root = defineCollection({
        name: "disclosure_root",
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        } as const,
        queries: {
          nested: {
            async select({ read }) {
              assertEquals(await read.get("disclosure_child", "missing"), null);
              if (denyFinal) allowed = false;
              return [];
            },
          },
        },
      });
      const runtime = createCollectionRuntime({
        session: f.db,
        eventStore: f.store,
        coordinator: f.coordinator,
        policies: validateCollectionPolicies({
          child: {
            authorize(intent) {
              phases.push(intent.phase);
              if (!allowed) {
                throw new ActionError("Nested current policy refused.", {
                  code: "forbidden",
                  status: 403,
                });
              }
            },
          },
        }, { child, root }),
      });
      runtime.bind(child);
      runtime.bind(root);
      const authority = {
        scope: { databaseSchema: f.schema, namespace: "space" },
        invocation: {
          kind: "processor" as const,
          id: "nested-reader",
          runId: "current",
        },
        signal: new AbortController().signal,
        check() {},
        resolveSource(): Promise<never> {
          throw new Error("unused");
        },
      };
      const read = () =>
        withOwnerCollectionInvocation(
          authority,
          () =>
            runtime.withScope({ namespace: "space" }).disclosure_root.queries
              .nested({}),
        );
      try {
        if (denyFinal) {
          const error = await assertRejects(read);
          assertEquals((error as { code: string }).code, "forbidden");
        } else assertEquals(await read(), []);
        assertEquals(phases, ["read", "result", "result"]);
      } finally {
        await f.close();
      }
    },
  });
}

Deno.test({
  name:
    "snapshot owner projection retains row and cumulative SQL read budgets and revoked query lifetime",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const projected = defineCollection({
      name: "boundary_projection",
      ownerPolicy: "required",
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      } as const,
      queries: {
        bounded: {
          ownerProjection: true,
          inputSchema: {
            type: "object",
            properties: { mode: { type: "string" } },
            required: ["mode"],
          },
          outputSchema: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
        },
      },
    });
    let retained!: () => Promise<unknown>;
    let transferred = 0;
    const runtime = createCollectionRuntime({
      session: f.db,
      eventStore: f.store,
      coordinator: f.coordinator,
      policies: validateCollectionPolicies({ projected: { authorize() {} } }, {
        projected,
      }),
      projections: validateCollectionProjections({
        projected: {
          bounded: {
            async select(input, context) {
              retained = () => context.query("SELECT 1");
              const bytes = input.mode === "oversized"
                ? 300000
                : input.mode === "cumulative"
                ? 200000
                : 100000;
              for (let index = 0; index < 3; index++) {
                const rows = await context.query<{ value: string }>(
                  "SELECT repeat('x', $1::integer) AS value",
                  [bytes],
                );
                transferred += rows.rows[0].value.length;
              }
              return [{ id: "safe" }];
            },
          },
        },
      }, { projected }),
    });
    runtime.bind(projected);
    const authority = {
      scope: { databaseSchema: f.schema, namespace: "space" },
      invocation: {
        kind: "viewer" as const,
        id: "viewer",
        runId: "read",
        actor: { id: "viewer" },
        claims: {},
      },
      signal: new AbortController().signal,
      check() {},
      resolveSource(): Promise<never> {
        throw new Error("unused");
      },
    };
    const read = (mode: string) =>
      withOwnerCollectionInvocation(
        authority,
        () =>
          runtime.readSnapshot({ namespace: "space" }, ({ collections }) =>
            collections.boundary_projection.queries.bounded({ mode })),
      );
    try {
      assertEquals<unknown>(await read("small"), [{ id: "safe" }]);
      assertEquals(transferred, 300000);
      await assertRejects(retained, Error, "closed");
      transferred = 0;
      await assertRejects(
        () => read("oversized"),
        RangeError,
        "transfer budget",
      );
      assertEquals(transferred, 0);
      await assertRejects(retained, Error, "closed");
      transferred = 0;
      await assertRejects(
        () => read("cumulative"),
        RangeError,
        "transfer budget",
      );
      assertEquals(transferred, 400000);
      await assertRejects(retained, Error, "closed");
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "independent publication drops source transaction scope while retained mutation planning stays closed",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finishPlanning = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    let retained!: () => Promise<unknown>;
    const held = f.owner.register("boundary.planning-a", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const next = f.owner.register("boundary.planning-b", {
      authorize() {},
      execute(_input: unknown, command) {
        command.afterCommit(async () => {
          try {
            await ended.promise;
            await assertRejects(async () => await retained(), Error, "closed");
            await f.runtime.transaction({
              namespace: "space",
              operationKey: "independent-b",
              async execute({ collections }) {
                await collections.boundary_record.create({ id: "b" });
              },
            });
            published.resolve();
          } catch (error) {
            published.reject(error);
          }
        });
      },
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let root: Promise<void> | undefined;
    try {
      root = f.runtime.transaction({
        namespace: "space",
        operationKey: "planning-a",
        async execute({ collections }) {
          retained = () =>
            collections.boundary_record.create({ id: "too-late" });
          first = held(f.caller, { input: {} });
          await entered.promise;
          await finishPlanning.promise;
        },
      }).then(() => ended.resolve());
      await bounded(entered.promise, "A planning scope seeds owner drain");
      second = next(f.caller, { input: {} });
      finishPlanning.resolve();
      release.resolve();
      await bounded(
        Promise.all([root, first, second, published.promise]),
        "independent B creates its own transaction scope",
      );
      assertEquals(
        (await f.db.query(
          `SELECT id FROM "${f.schema}".nodes WHERE type='boundary_record'`,
        )).rows,
        [{ id: "b" }],
      );
    } finally {
      finishPlanning.resolve();
      release.resolve();
      ended.resolve();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await root?.catch(() => undefined);
      await f.close();
    }
  },
});
