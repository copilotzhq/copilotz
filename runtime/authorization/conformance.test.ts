import { completeOwnerDeadline } from "../engine/alarms.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import {
  activateDatabaseOwner,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCollectionRuntime } from "../collections/kernel.ts";
import {
  authorizationRefused,
  collectionAuthorizations,
  createOwnerEvaluator,
  type OwnerAuthorization,
  validateOwnerAuthorization,
} from "./evaluator.ts";
import { withRetainedAuthority } from "./binding.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "./authority.ts";
import { createAuthorizationOwner } from "./owner.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { afterSqlCommit } from "../events/session.ts";

const member = defineCollection({
  name: "member",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, allowed: { type: "boolean" } },
    required: ["id", "allowed"],
  },
});
const record = defineCollection({
  name: "entry",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      owner: { type: "string" },
      title: { type: "string" },
    },
    required: ["id", "owner", "title"],
  },
  queries: { visible: { query: () => ({ limit: 1 }) } },
});
async function fixture(denyCommittedResult = false, vector = false) {
  let resultChecks = 0;
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
    ...(vector ? { pgliteExtensions: ["vector"] } : {}),
  });
  const schema = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const run = createSchemaCommandRunner(db, schema);
  const store = createEventStore({ session: db, schema });
  const authority: AuthenticatedAuthority = {
    version: 1,
    principal: { kind: "api-key", id: "key" },
    scope: {
      owner: "schema",
      databaseSchema: schema,
      tenant: "one",
      namespace: "main",
      bindings: {},
    },
    validity: credentialValidity(new Date()),
    policy: { id: "application", revision: "1" },
    requestFacts: {
      endpoint: "entries",
      transport: "http",
      operation: "read",
      params: {},
      input: null,
    },
    provenance: { ingress: "http", source: "request" },
    dependencies: [],
    authorityBasis: { kind: "credential", id: "key" },
  };
  const collections = { member, entry: record };
  const registration: OwnerAuthorization = {
    policies: {
      application: {
        revision: "1",
        sources: ["member"],
        async evaluate({ read, intent }) {
          if (
            denyCommittedResult && intent.kind === "collection" &&
            intent.operation === "create" &&
            (intent.input as { phase?: string }).phase === "result" &&
            ++resultChecks === 2
          ) authorizationRefused();
          if (
            !(await read.get("member", "key"))?.allowed
          ) authorizationRefused();
          return {
            collections: { entry: { where: { owner: "key" } } },
            collectionMutations: {
              entry: {
                create: {
                  fields: ["id", "title"],
                  input: { owner: "key" },
                  filter: { where: { owner: "key" } },
                },
                update: {
                  fields: ["title"],
                  filter: { where: { owner: "key" } },
                },
                delete: { filter: { where: { owner: "key" } } },
              },
            },
            operations: {
              metadata: { keyId: "key" },
              absentMetadata: ["computerOperationKind"],
            },
            sessions: {
              create: { principal: "account", maxAge: 3600 },
              revoke: "tenant",
            },
          };
        },
      },
    },
    collections: { entry: { id: "application", revision: "1" } },
    actions: {},
  };
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({
          ...input,
          consumers: [],
          onCommitted() {},
        }),
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
    policies: collectionAuthorizations(registration, collections, schema),
  });
  runtime.bind(member);
  runtime.bind(record);
  const setMember = (allowed: boolean) =>
    run("fixture.membership", {}, async (_, command) => {
      await command.transaction.query(
        `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('key','main','member','key',$1::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET data=EXCLUDED.data`,
        [JSON.stringify({ allowed })],
      );
    });
  await setMember(true);
  const bound = <T>(work: () => T | Promise<T>, binding = authority) =>
    withRetainedAuthority(binding, new AbortController().signal, work);
  const evaluate = createOwnerEvaluator({
    registration,
    collections,
    databaseSchema: schema,
  });
  const operations = {
    get() {
      return Promise.resolve(null);
    },
  } as unknown as OperationCatalog;
  const authorization = createAuthorizationOwner({
    session: db,
    databaseSchema: schema,
    owner,
    registration,
    collections,
    operations,
  });
  await activateDatabaseOwner(owner, () => Promise.resolve());
  return {
    db,
    schema,
    owner,
    run,
    store,
    runtime,
    authority,
    registration,
    collections,
    setMember,
    bound,
    evaluate,
    authorization,
    async close() {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test("F4 owner reads policy after authentication and before pagination, aggregates and named queries", async () => {
  const f = await fixture();
  try {
    await f.run("fixture.rows", {}, async (_, { transaction }) => {
      for (const [id, owner] of [["a", "other"], ["b", "key"], ["c", "key"]]) {
        await transaction.query(
          `INSERT INTO "${f.schema}".nodes(id,namespace,type,name,data) VALUES($1,'main','entry',$1,$2::jsonb)`,
          [id, JSON.stringify({ owner, title: id })],
        );
      }
    });
    const collection = f.runtime.withScope({ namespace: "main" }).entry;
    assertEquals(
      (await f.bound(() => collection.list({ limit: 1 }))).map((item) =>
        item.id
      ),
      ["b"],
    );
    assertEquals(
      (await f.bound(() => collection.queries.visible({}))).map((item) =>
        item.id
      ),
      ["b"],
    );
    const count = await f.bound(() =>
      collection.aggregate({ metrics: { count: { op: "count" } } })
    );
    assertEquals(Number(count[0].count), 2);
    await f.setMember(false);
    await assertRejects(() => f.bound(() => collection.list()), Error);
  } finally {
    await f.close();
  }
});

Deno.test("F4 owner writes insert trusted inputs and reject conflicts, protected fields and resulting scope", async () => {
  const f = await fixture();
  try {
    const entry = f.runtime.withScope({ namespace: "main" }).entry;
    const created = await f.bound(() =>
      entry.create({ id: "new", title: "hello" })
    );
    assertEquals(created.owner, "key");
    await assertRejects(
      () =>
        f.bound(() =>
          entry.create({ id: "forged", title: "bad", owner: "other" })
        ),
      Error,
    );
    await assertRejects(
      () => f.bound(() => entry.update({ id: "new", set: { owner: "other" } })),
      Error,
    );
    await assertRejects(
      () =>
        f.bound(() => entry.update({ id: "new", set: { namespace: "other" } })),
      Error,
    );
    await f.setMember(false);
    await assertRejects(
      () =>
        f.bound(() => entry.update({ id: "new", set: { title: "revoked" } })),
      Error,
    );
    assertEquals(
      (await f.db.query<{ data: { title: string } }>(
        `SELECT data FROM "${f.schema}".nodes WHERE namespace='main' AND id='new'`,
      )).rows[0].data.title,
      "hello",
    );
  } finally {
    await f.close();
  }
});

Deno.test("F4 unknown revisions, expired commands, undeclared reads and incomplete registrations fail closed", async () => {
  const f = await fixture();
  try {
    const entry = f.runtime.withScope({ namespace: "main" }).entry;
    await assertRejects(() =>
      f.bound(() => entry.list(), {
        ...f.authority,
        policy: { id: "application", revision: "unknown" },
      })
    );
    await assertRejects(() =>
      f.bound(() => entry.list(), {
        ...f.authority,
        validity: credentialValidity(new Date(Date.now() - 16 * 60_000)),
      })
    );
    assertThrows(() =>
      validateOwnerAuthorization(undefined, { entry: record }, {})
    );
    const evaluate = createOwnerEvaluator({
      registration: {
        ...f.registration,
        policies: {
          application: {
            revision: "1",
            sources: [],
            async evaluate({ read }) {
              await read.get("member", "key");
              return {};
            },
          },
        },
      },
      collections: f.collections,
      databaseSchema: f.schema,
    });
    await assertRejects(() =>
      f.run(
        "fixture.undeclared",
        {},
        (_, command) =>
          evaluate(f.authority, {
            kind: "collection",
            resource: "entry",
            operation: "list",
            input: {},
          }, command),
      )
    );
  } finally {
    await f.close();
  }
});

Deno.test("F4 source notices re-authorize idle channels; refusal fences every later publication", async () => {
  const f = await fixture();
  try {
    const denied = Promise.withResolvers<unknown>();
    const observation = await f.authorization.observe(
      f.authority,
      {},
      denied.resolve,
    );
    let sent = 0;
    await observation.publish(() => {
      sent++;
      return Promise.resolve();
    });
    await f.run("fixture.revoke", {}, async (_, command) => {
      await command.transaction.query(
        `UPDATE "${f.schema}".nodes SET data='{"allowed":false}' WHERE namespace='main' AND id='key'`,
      );
      afterSqlCommit(
        command.transaction,
        () =>
          f.authorization.notice({
            namespace: "main",
            collection: "member",
            id: "key",
          }),
      );
    });
    await denied.promise;
    await assertRejects(() =>
      observation.publish(() => {
        sent++;
        return Promise.resolve();
      })
    );
    assertEquals(sent, 1);
    observation.close();
  } finally {
    await f.close();
  }
});

Deno.test("F4 tenant logout commits revocation, refuses replay and closes only its own session", async () => {
  const f = await fixture();
  try {
    await f.authorization.createSession(f.authority, {
      id: "session",
      principal: "account",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await f.authorization.createSession({
      ...f.authority,
      scope: { ...f.authority.scope, tenant: "two" },
    }, {
      id: "session",
      principal: "account",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const binding: AuthenticatedAuthority = {
      ...f.authority,
      principal: { kind: "session", id: "account" },
      authorityBasis: { kind: "session", id: "session" },
    };
    await assertRejects(() =>
      f.authorization.observe(
        {
          ...binding,
          principal: { kind: "session", id: "another-account" },
        },
        {},
        () => {},
      )
    );
    const revoked = Promise.withResolvers<unknown>();
    const first = await f.authorization.observe(binding, {}, revoked.resolve);
    let otherRevoked = false;
    const other = await f.authorization.observe(
      { ...binding, scope: { ...binding.scope, tenant: "two" } },
      {},
      () => {
        otherRevoked = true;
      },
    );
    await f.authorization.revokeSession(binding, "session");
    await revoked.promise;
    await assertRejects(() => first.publish(() => Promise.resolve()));
    await assertRejects(() => f.authorization.observe(binding, {}, () => {}));
    await other.publish(() => Promise.resolve());
    assertEquals(otherRevoked, false);
    other.close();
  } finally {
    await f.close();
  }
});

Deno.test("F4 owner expiry alarm closes an idle credential channel without a write", async () => {
  const f = await fixture();
  try {
    const end = new Date(Date.now() + 100).toISOString();
    const denied = Promise.withResolvers<unknown>();
    const channel = await f.authorization.observe(
      {
        ...f.authority,
        validity: {
          kind: "credential",
          admittedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: end,
        },
      },
      {},
      denied.resolve,
    );
    const timer = setTimeout(
      () => denied.reject(new Error("Expiry alarm did not fire")),
      3000,
    );
    try {
      assertEquals(
        (await denied.promise as { code: string }).code,
        "observation_renewal_required",
      );
    } finally {
      clearTimeout(timer);
    }
    await assertRejects(() => channel.publish(() => Promise.resolve()));
    channel.close();
  } finally {
    await f.close();
  }
});

Deno.test("F4 empty-source insertion revokes; unrelated namespaces do not; takeover fences old publication", async () => {
  const f = await fixture();
  try {
    const service = createAuthorizationOwner({
      session: f.db,
      databaseSchema: f.schema,
      owner: f.owner,
      collections: f.collections,
      operations: {} as OperationCatalog,
      registration: {
        ...f.registration,
        policies: {
          application: {
            revision: "1",
            sources: ["member"],
            async evaluate({ read }) {
              if (
                (await read.list("member", { where: { allowed: false } }))
                  .length
              ) authorizationRefused();
              return {};
            },
          },
        },
      },
    });
    const failed = Promise.withResolvers<unknown>();
    const channel = await service.observe(f.authority, {}, failed.resolve);
    service.notice({ namespace: "another", collection: "member" });
    await channel.publish(() => Promise.resolve());
    await f.run("insert-negative-dependency", {}, async (_, command) => {
      await command.transaction.query(
        `INSERT INTO "${f.schema}".nodes(id,namespace,type,name,data) VALUES('revoked','main','member','revoked','{"allowed":false}')`,
      );
      afterSqlCommit(
        command.transaction,
        () =>
          service.notice({
            namespace: "main",
            collection: "member",
            id: "revoked",
          }),
      );
    });
    await failed.promise;
    await assertRejects(() => channel.publish(() => Promise.resolve()));
    const active = await f.authorization.observe(f.authority, {}, () => {});
    f.owner.stop(new Error("Owner replaced."));
    await assertRejects(() => active.publish(() => Promise.resolve()));
  } finally {
    await f.close();
  }
});

Deno.test("F4 asset access needs an explicit current record reference, beyond a thread predicate", async () => {
  const f = await fixture();
  try {
    await assertRejects(() => f.authorization.asset(f.authority, "asset-one"));
    const service = createAuthorizationOwner({
      session: f.db,
      databaseSchema: f.schema,
      owner: f.owner,
      collections: f.collections,
      operations: {} as OperationCatalog,
      registration: {
        ...f.registration,
        policies: {
          application: {
            revision: "1",
            sources: ["member"],
            async evaluate({ read }) {
              const reference = await read.get("member", "reference");
              return {
                collections: { entry: { where: { owner: "key" } } },
                assets: {
                  read: typeof reference?.assetId === "string"
                    ? [reference.assetId]
                    : [],
                },
              };
            },
          },
        },
      },
    });
    await assertRejects(() => service.asset(f.authority, "asset-one"));
    await f.run(
      "reference",
      {},
      (_, command) =>
        command.transaction.query(
          `INSERT INTO "${f.schema}".nodes(id,namespace,type,name,data) VALUES('reference','main','member','reference','{"assetId":"asset-one"}')`,
        ),
    );
    await service.asset(f.authority, "asset-one");
    await assertRejects(() => service.asset(f.authority, "asset-two"));
    await f.run(
      "remove-reference",
      {},
      (_, command) =>
        command.transaction.query(
          `DELETE FROM "${f.schema}".nodes WHERE id='reference'`,
        ),
    );
    await assertRejects(() => service.asset(f.authority, "asset-one"));
  } finally {
    await f.close();
  }
});

Deno.test("F4 failed logout commit leaves the session and channel live", async () => {
  const f = await fixture();
  try {
    await f.authorization.createSession(f.authority, {
      id: "session",
      principal: "account",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const authority: AuthenticatedAuthority = {
      ...f.authority,
      principal: { kind: "session", id: "account" },
      authorityBasis: { kind: "session", id: "session" },
    };
    const channel = await f.authorization.observe(authority, {}, () => {});
    await assertRejects(() =>
      f.run("failed-logout", {}, async () => {
        await f.authorization.revokeSession(f.authority, "session");
        throw new Error("Commit refused.");
      })
    );
    await channel.publish(() => Promise.resolve());
    channel.close();
  } finally {
    await f.close();
  }
});

Deno.test("F4 historical snapshots use current authority and authorize the actual retained row", async () => {
  const f = await fixture();
  try {
    await f.run("fixture.rows", {}, async (_, { transaction }) => {
      await transaction.query(
        `INSERT INTO "${f.schema}".nodes(id,namespace,type,name,data) VALUES('historic','main','entry','historic','{"owner":"other","title":"private"}')`,
      );
    });
    const move = () =>
      f.run("fixture.move", {}, async (_, { transaction }) => {
        await transaction.query(
          `UPDATE "${f.schema}".nodes SET data='{"owner":"key","title":"public"}' WHERE id='historic'`,
        );
      });
    const pooled = !!Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
    await f.bound(() =>
      f.runtime.readSnapshot(
        { namespace: "main" },
        ({ collections }) =>
          f.bound(async () => {
            // Pin the historical data snapshot, then change the current row's scope.
            assertEquals(await collections.entry.list(), []);
            // PostgreSQL can commit another owner command while the historical
            // snapshot stays pinned. PGlite serializes both on one transaction.
            if (pooled) await move();
            await assertRejects(() =>
              collections.entry.get({ id: "historic" })
            );
          }),
      )
    );
    if (!pooled) await move();
    await f.bound(() =>
      f.runtime.readSnapshot(
        { namespace: "main" },
        ({ collections }) =>
          f.bound(async () => {
            assertEquals((await collections.entry.list()).length, 1);
            await f.setMember(false);
            await assertRejects(() => collections.entry.list());
          }),
      )
    );
  } finally {
    await f.close();
  }
});

Deno.test("F4 vector policy filters candidates before top-K and rechecks current authority", async () => {
  const { provisionVectorStorage, projectVector } = await import(
    "../vectors/index.ts"
  );
  const f = await fixture(false, true);
  const profile = {
    model: "fixture",
    revision: "1",
    dimensions: 2,
    metric: "cosine" as const,
  };
  try {
    await provisionVectorStorage(f.db, f.schema);
    await f.run("fixture.rows", {}, async (_, { transaction }) => {
      for (const [id, owner] of [["private", "other"], ["visible", "key"]]) {
        await transaction.query(
          `INSERT INTO "${f.schema}".nodes(id,namespace,type,name,data) VALUES($1,'main','entry',$1,$2::jsonb)`,
          [id, JSON.stringify({ owner, title: id })],
        );
      }
    });
    await f.run("fixture.vectors", {}, async (_, { transaction }) => {
      for (
        const [id, values] of [["private", [1, 0]], ["visible", [
          0.9,
          0.1,
        ]]] as const
      ) {
        await projectVector(transaction, f.schema, "main", {
          ownerType: "entry",
          ownerId: id,
          field: "title",
          sourceField: "title",
          source: id,
          profile,
          values,
        });
      }
    });
    const query = {
      ownerType: "entry",
      field: "title",
      profile,
      values: [1, 0],
      filter: { and: [] },
      limit: 1,
    };
    assertEquals(
      (await f.bound(() => f.runtime.vectors("main").search(query))).map((
        item,
      ) => item.record.id),
      ["visible"],
    );
    await f.setMember(false);
    await assertRejects(() =>
      f.bound(() => f.runtime.vectors("main").search(query))
    );
  } finally {
    await f.close();
  }
});

Deno.test("F4 mutation committed before disclosure refusal reports its committed outcome", async () => {
  const f = await fixture(true);
  try {
    const error = await assertRejects(() =>
      f.bound(() =>
        f.runtime.withScope({ namespace: "main" }).entry.create({
          id: "committed",
          title: "stored",
        })
      )
    );
    assertEquals(
      (error as { code?: string }).code,
      "collection_result_denied_after_commit",
    );
    assertEquals(
      (error as { commitOutcome?: string }).commitOutcome,
      "committed",
    );
    assertEquals(
      (await f.db.query(
        `SELECT id FROM "${f.schema}".nodes WHERE id='committed'`,
      )).rows,
      [{ id: "committed" }],
    );
  } finally {
    await f.close();
  }
});

Deno.test("F4 delegated commands retain both identities and fail after attempt retirement", async () => {
  const f = await fixture();
  f.owner.registerAlarmSource({
    name: "deliveries",
    async wake(deadlines) {
      await f.run("fixture.deliveries", {}, async (_, command) => {
        for (const deadline of deadlines) {
          await completeOwnerDeadline(command.transaction, f.schema, deadline);
        }
      });
    },
  });
  try {
    const accepted = await f.store.append({
      namespace: "main",
      type: "delegated",
      payload: {},
    }, ["worker"]);
    const delivery = await f.store.claimDelivery({
      id: accepted.deliveries[0].id,
      owner: "executor",
      leaseMs: 60000,
    });
    if (!delivery) throw new Error("Fixture delivery was not claimed");
    const binding: AuthenticatedAuthority = {
      ...f.authority,
      principal: {
        kind: "worker",
        id: "executor",
        executing: "agent",
        initiating: "service",
      },
      validity: {
        kind: "attempt",
        attempt: delivery.id,
        worker: "executor",
        epoch: String(f.owner.epoch),
      },
      requestFacts: { ...f.authority.requestFacts, transport: "worker" },
      provenance: {
        ingress: "worker",
        source: accepted.event.id,
        parent: "parent",
      },
      authorityBasis: { kind: "attempt", id: delivery.id },
    };
    await f.bound(
      () => f.runtime.withScope({ namespace: "main" }).entry.list(),
      binding,
    );
    await f.store.succeedDelivery(delivery.id, "executor");
    await assertRejects(() =>
      f.bound(
        () => f.runtime.withScope({ namespace: "main" }).entry.list(),
        binding,
      )
    );
  } finally {
    await f.close();
  }
});
