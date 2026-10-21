import { assertEquals, assertRejects } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import { defineCollection } from "../collections/definition.ts";

import { createCollectionRuntime } from "../collections/kernel.ts";
import { withOwnerCollectionInvocation } from "../authorization/invocation.ts";
import { testCollectionAuthorizations } from "../testing/collection-authorization.ts";
import { testAuthority } from "../testing/authority.ts";
import type { CollectionPolicyIntent } from "../authorization/intent.ts";
import { queryCollectionRows } from "../collections/read-rows.ts";
import { readViews } from "../collections/read-view.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { bounded, localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "./commands.ts";

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
  owner.activate();
  const store = createEventStore({ session: db, schema });
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },

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
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name: "queued commands and publication drop caller hop views",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const held = f.owner.register("boundary.a", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const next = f.owner.register("boundary.b", {
      authorize() {},
      execute(_input: unknown, command) {
        assertEquals(readViews.memo(), undefined);
        command.afterCommit(() => {
          try {
            assertEquals(readViews.memo(), undefined);
            published.resolve();
          } catch (error) {
            published.reject(error);
          }
        });
      },
    });
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      first = readViews.run(async () => {
        readViews.memo()!.begin(["same-key"]).remember("same-key", "A");
        await held(f.caller, { input: {} });
      });
      await entered.promise;
      second = readViews.run(async () => {
        readViews.memo()!.begin(["same-key"]).remember("same-key", "B");
        await next(f.caller, { input: {} });
      });
      release.resolve();
      await Promise.all([first, second]);
      await bounded(published.promise, "publication drops hop view");
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await f.close();
    }
  },
});

Deno.test({
  name: "queued unscoped B does not inherit A's memo",
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
      first = readViews.run(async () => {
        readViews.memo()!.begin(["only-a"]).remember("only-a", "A");
        await held(f.caller, { input: {} });
      });
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
      policies: testCollectionAuthorizations(
        { guarded },
        f.schema,
        async ({ authority, intent }) => {
          const phase = (intent.input as CollectionPolicyIntent).phase;
          seen.push(`${authority.principal.id}:${phase}`);
          if (authority.principal.id === "a" && phase === "read") {
            entered.resolve();
            await release.promise;
          }
          return { collections: { guarded: {} } };
        },
      ),
    });
    runtime.bind(guarded);
    const authority = (id: string) => ({
      authority: testAuthority(f.schema, "space", id),
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

        await f.runtime.transaction({
          namespace: "space",
          operationKey: "fresh-joined",
          async execute({ collections }) {
            await collections.boundary_record.create({ id: "b" });
          },
        }, command);
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
        policies: testCollectionAuthorizations(
          { child, root },
          f.schema,
          ({ intent }) => {
            // The outer named query also requires a binding under F4.
            if (intent.resource === "root") {
              return { collections: { root: {}, child: {} } };
            }
            phases.push((intent.input as CollectionPolicyIntent).phase);
            if (!allowed) {
              throw new ActionError("Nested current policy refused.", {
                code: "forbidden",
                status: 403,
              });
            }
            return { collections: { root: {}, child: {} } };
          },
        ),
      });
      runtime.bind(child);
      runtime.bind(root);
      const authority = {
        authority: testAuthority(f.schema, "space", "nested-reader"),
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
