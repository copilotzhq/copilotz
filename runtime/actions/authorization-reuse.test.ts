import { assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { bindSqlDatabaseIdentity } from "../events/database-identity.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { authorityIngressProof } from "../application/ingress/authority.ts";
import { testAuthority } from "../testing/authority.ts";
import { credentialValidity } from "../authorization/authority.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "../authorization/evaluator.ts";
import { defineCollection } from "../collections/definition.ts";
import { projectCollectionEvent } from "../collections/reducer.ts";
import { defineAction } from "./define.ts";
import { createAuthorizedActions } from "./authorized-capture.ts";
import type { ActionInvocationFrame } from "./invoker.ts";

async function fixture(withDelivery = false) {
  const database = await createOwnerTestDatabase();
  const statements: string[] = [];
  const observe = (tx: SqlExecutor): SqlExecutor => ({
    query(sql, params) {
      statements.push(sql);
      return tx.query(sql, params);
    },
  });
  const db: SqlSession = bindSqlDatabaseIdentity({
    ...observe(database),
    transaction: (run) => database.transaction((tx) => run(observe(tx))),
  }, database);
  const schema = "public", namespace = "space";
  await provisionCopilotzSchema(db, schema);
  let time = Date.now();
  let owner = await openDatabaseOwner(db, schema, {
    now: () => new Date(time),
  });
  let store = createEventStore({ session: db, schema });
  const member = defineCollection({
    name: "member",
    schema: {
      type: "object",
      properties: { id: { type: "string" }, allowed: { type: "boolean" } },
      required: ["id", "allowed"],
    } as const,
  });
  const action = defineAction({
    id: "test.reuse",
    execute: (input: unknown) => input,
  });
  let evaluations = 0;
  const policy = {
    revision: "1",
    sources: ["member"],
    async evaluate(
      { read }: Parameters<
        OwnerAuthorization["policies"][string]["evaluate"]
      >[0],
    ) {
      evaluations++;
      const rows = await Promise.all([
        read.get("member", "membership"),
        read.get("member", "membership"),
        read.get("member", "membership"),
      ]);
      if (!rows.every((row) => row?.allowed)) authorizationRefused();
      return { actions: { action: {} } };
    },
  };
  const registration = {
    policies: { fixture: policy },
    collections: {},
    actions: { action: { id: "fixture", revision: "1" } },
  } satisfies OwnerAuthorization;
  const authority = {
    ...testAuthority(schema, namespace),
    principal: { kind: "session" as const, id: "member" },
    authorityBasis: { kind: "session" as const, id: "session" },
    validity: credentialValidity(new Date(time)),
  };
  let run = createSchemaCommandRunner(db, schema);
  await run("seed", {}, async (_, command) => {
    await command.transaction.query(
      `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('membership','space','member','membership','{"allowed":true}')`,
    );
    await command.transaction.query(
      `INSERT INTO public.authorization_sessions(namespace,tenant,id,principal,expires_at) VALUES('space','fixture','session','member',$1)`,
      [new Date(time + 60_000).toISOString()],
    );
  });
  const root = await store.commitMutation({
    draft: { namespace, type: "test.source", payload: {} },
    ingress: authorityIngressProof(authority),
    consumers: withDelivery
      ? [{ consumerId: "processor", settlement: "inherit" }]
      : [],
  });
  const writer = withDelivery
    ? {
      kind: "delivery" as const,
      deliveryId: root.deliveries[0].id,
      leaseOwner: "attempt",
    }
    : undefined;
  if (writer) {
    await store.claimDelivery({
      id: writer.deliveryId,
      owner: writer.leaseOwner,
      leaseMs: 1000,
    });
  }
  const make = () => {
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
    return createAuthorizedActions({
      authorization: registration,
      collections: { member },
      actions: { action },
      store,
      coordinator,
      namespace,
      source: { eventId: root.event.id },
      writer,
      signal: owner.signal,
    });
  };
  const frame: ActionInvocationFrame = {
    actionId: action.id,
    actionRunId: "run",
    rootKey: "root",
    operationKey: "run",
    metadata: {},
    identity: { settlementScopeId: root.event.id },
    signal: new AbortController().signal,
    nextActionIndex: () => 1,
  };
  let hooks = make();
  const call = (selected = hooks) =>
    run("capability", {}, async (_, command) => {
      const before = statements.length;
      await selected.output(frame).authorize!(command.transaction);
      return statements.length - before;
    });
  return {
    db,
    writer,
    statements,
    frame,
    authority,
    registration,
    policy,
    make,
    get hooks() {
      return hooks;
    },
    get run() {
      return run;
    },
    get evaluations() {
      return evaluations;
    },
    call,
    advance(ms: number) {
      time += ms;
    },
    async write(allowed: boolean, id = "membership") {
      await run("membership", {}, (_, command) =>
        projectCollectionEvent(
          { transaction: command.transaction, tables: store.tables },
          member,
          {
            operation: "update",
            id,
            set: { allowed },
            unset: [],
            intent: { operation: "update", id, set: { allowed }, unset: [] },
            record: {
              id,
              namespace,
              allowed,
              createdAt: new Date(time).toISOString(),
              updatedAt: new Date(time).toISOString(),
            },
            assets: [],
          },
        ));
    },
    async insert(id: string, allowed: boolean) {
      await run("insert", {}, (_, command) =>
        projectCollectionEvent(
          { transaction: command.transaction, tables: store.tables },
          member,
          {
            operation: "create",
            intent: { operation: "create", input: { id, allowed } },
            record: {
              id,
              namespace,
              allowed,
              createdAt: new Date(time).toISOString(),
              updatedAt: new Date(time).toISOString(),
            },
            assets: [],
          },
        ));
    },
    async restart() {
      await releaseDatabaseOwner(owner);
      owner = await openDatabaseOwner(db, schema, {
        now: () => new Date(time),
      });
      store = createEventStore({ session: db, schema });
      run = createSchemaCommandRunner(db, schema);
      hooks = make();
    },
    async close() {
      await releaseDatabaseOwner(owner);
      await database.close();
    },
  };
}

Deno.test("Action capture reuse: N capabilities have one evaluation and zero authorization SQL; cold baseline counts", async () => {
  const f = await fixture();
  try {
    await f.hooks.prepareInput(f.frame, {});
    assertEquals(f.evaluations, 1);
    const warm: number[] = [], warmCommandSql: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = f.statements.length;
      warm.push(await f.call());
      warmCommandSql.push(f.statements.length - before);
    }
    assertEquals(warm, Array(8).fill(0));
    assertEquals(f.evaluations, 1);
    const cold: number[] = [], coldCommandSql: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = f.statements.length;
      cold.push(await f.call(f.make()));
      coldCommandSql.push(f.statements.length - before);
    }
    assertEquals(f.evaluations, 9);
    assertEquals(cold.every((count) => count > 0), true);
    console.log(
      JSON.stringify({
        capabilities: 8,
        cold: {
          evaluationsPerCall: 1,
          sqlPerCall: cold,
          commandSqlPerCall: coldCommandSql,
        },
        warm: {
          captureEvaluations: 1,
          evaluationsPerCall: 0,
          sqlPerCall: warm,
          commandSqlPerCall: warmCommandSql,
        },
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("Action reuse invalidates exact dependency writes, raw writes, rollback, revocation and expiry", async (t) => {
  const f = await fixture();
  try {
    await f.hooks.prepareInput(f.frame, {});
    await t.step(
      "dependency change re-evaluates; unrelated record preserves grant",
      async () => {
        await f.run("other", {}, async (_, c) => {
          await c.transaction.query(
            `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('other','space','member','other','{"allowed":true}')`,
          );
        });
        await f.call(); // raw SQL conservatively invalidates the table
        const before = f.evaluations;
        await f.write(false, "other");
        assertEquals(await f.call(), 0);
        assertEquals(f.evaluations, before);
        await f.write(false);
        await assertRejects(() => f.call());
        assertEquals(f.evaluations, before + 1);
        await f.write(true);
        await f.call();
      },
    );
    await t.step(
      "write and next capability in the same command observe new facts",
      async () => {
        await assertRejects(() =>
          f.run("rollback", {}, async (_, command) => {
            await command.transaction.query(
              `UPDATE public.nodes SET data='{"allowed":false}' WHERE id='membership'`,
            );
            await f.hooks.output(f.frame).authorize!(command.transaction);
          })
        );
        await f.call(); // rollback leaves the durable membership allowed
      },
    );
    await t.step("session revocation refuses very next call", async () => {
      await f.run(
        "revoke",
        {},
        (_, c) =>
          c.transaction.query(
            `UPDATE public.authorization_sessions SET revoked_at=NOW() WHERE id='session'`,
          ),
      );
      await assertRejects(() => f.call());
      await f.run(
        "restore-fixture",
        {},
        (_, c) =>
          c.transaction.query(
            `UPDATE public.authorization_sessions SET revoked_at=NULL WHERE id='session'`,
          ),
      );
      await f.call();
    });
    await t.step(
      "known session deadline refuses without another write",
      async () => {
        f.advance(60_000);
        await assertRejects(() => f.call());
      },
    );
  } finally {
    await f.close();
  }
});

Deno.test("Action reuse never upgrades retained policy authority and owner restart is cold", async () => {
  const f = await fixture();
  try {
    await f.hooks.prepareInput(f.frame, {});
    assertEquals(await f.call(), 0);
    const oldHooks = f.hooks;
    await f.restart();
    await assertRejects(() => f.call(oldHooks));
    assertEquals(await f.call() > 0, true);
    assertEquals(f.evaluations, 2);
    assertEquals(await f.call(), 0);
    f.policy.revision = "2";
    await assertRejects(() => f.call());
    assertEquals(f.evaluations, 2); // revision mismatch refuses before invoking a new policy
    f.policy.revision = "1";
    const original = f.policy.evaluate;
    f.registration.policies.fixture = {
      ...f.policy,
      evaluate(context) {
        return original(context);
      },
    };
    assertEquals(await f.call() > 0, true);
    assertEquals(f.evaluations, 3);
  } finally {
    await f.close();
  }
});

Deno.test("evaluator command memo deduplicates session and detached record reads across evaluations, invalidating on writes", async () => {
  const f = await fixture();
  try {
    const evaluate = createOwnerEvaluator({
      registration: f.registration,
      collections: {
        member: defineCollection({
          name: "member",
          schema: { type: "object" },
        }),
      },
      databaseSchema: "public",
    });
    await f.run("evaluations", {}, async (_, command) => {
      const before = f.statements.length;
      for (let i = 0; i < 4; i++) {
        await evaluate(f.authority, {
          kind: "action",
          resource: "action",
          operation: "authorize",
          input: {},
        }, command);
      }
      const sql = f.statements.slice(before);
      assertEquals(
        sql.filter((s) => s.includes("authorization_sessions")).length,
        1,
      );
      assertEquals(
        sql.filter((s) => /SELECT id,namespace,data/.test(s)).length,
        1,
      );
      await command.transaction.query(
        `UPDATE public.authorization_sessions SET revoked_at=NOW() WHERE id='session'`,
      );
      await assertRejects(() =>
        evaluate(f.authority, {
          kind: "action",
          resource: "action",
          operation: "authorize",
          input: {},
        }, command)
      );
    });
  } finally {
    await f.close();
  }
});

Deno.test("Action reuse tracks negative point reads and empty sets, and discards rolled-back capture", async (t) => {
  for (const mode of ["point", "set"] as const) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        const original = f.policy.evaluate;
        f.policy.evaluate = async (context) => {
          const blocked = mode === "point"
            ? await context.read.get("member", "blocked")
            : (await context.read.list("member", {
              where: { allowed: false },
            }))[0];
          if (blocked) authorizationRefused();
          return await original(context);
        };
        await assertRejects(() =>
          f.run("rolled-back-capture", {}, async (_, command) => {
            await f.hooks.prepareInput(f.frame, {}, command.transaction);
            throw new Error("rollback capture");
          })
        );
        await assertRejects(() => f.call());
        await f.hooks.prepareInput(f.frame, {});
        assertEquals(f.evaluations, 2);
        assertEquals(await f.call(), 0);
        await f.insert("blocked", false);
        await assertRejects(() => f.call());
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test("running delivery capability hits are SQL-free, and retirement or lease expiry fences the next call", async (t) => {
  for (const invalidation of ["retirement", "expiry"] as const) {
    await t.step(invalidation, async () => {
      const f = await fixture(true);
      try {
        await f.hooks.prepareInput(f.frame, {});
        for (let i = 0; i < 8; i++) assertEquals(await f.call(), 0);
        assertEquals(f.evaluations, 1);
        if (invalidation === "retirement") {
          await f.run("retire", {}, (_, command) =>
            command.transaction.query(
              `UPDATE public.event_deliveries SET status='succeeded' WHERE id=$1`,
              [f.writer!.deliveryId],
            ));
        } else f.advance(1000);
        await assertRejects(() => f.call());
        assertEquals(f.evaluations, 1);
      } finally {
        await f.close();
      }
    });
  }
});
