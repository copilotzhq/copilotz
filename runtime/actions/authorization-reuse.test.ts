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
import { type ActionInvocationFrame, createActionCallers } from "./invoker.ts";
import type { ActionContext } from "./types.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "./persistence.ts";
import {
  defineProcessor,
  type ProcessorContext,
  type ProcessorEvent,
} from "../plugins/processor.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { observeAuthorizationCache } from "../authorization/cache.ts";
import type { AuthenticatedAuthority } from "../authorization/authority.ts";

async function fixture(withDelivery: boolean | "attempt" = false) {
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
  await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  let firstId = true;
  const makeStore = () =>
    createEventStore({
      session: db,
      schema,
      createId: () => {
        if (firstId && withDelivery === "attempt") {
          firstId = false;
          return "delivery-A";
        }
        return crypto.randomUUID();
      },
      ...(withDelivery === "attempt"
        ? {
          admitOperationEventSql: catalog.admitEventSql,
          indexOperationEventSql: catalog.indexEventSql,
        }
        : {}),
    });
  let store = makeStore();
  const member = defineCollection({
    name: "member",
    schema: {
      type: "object",
      properties: { id: { type: "string" }, allowed: { type: "boolean" } },
      required: ["id", "allowed"],
    } as const,
  });
  const action = defineAction({
    id: withDelivery === "attempt" ? "llm.call" : "test.reuse",
    execute: async (input: unknown, context) => {
      if (withDelivery === "attempt") {
        for (let i = 0; i < 26; i++) await context.content.get("fixture");
      }
      return input;
    },
  });
  let evaluations = 0;
  const policy = {
    revision: "1",
    sources: ["member"],
    evidence: ["identity"],
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
    identityVerifiers: {
      identity: {
        revision: "1",
        actions: ["action"],
        verify() {
          return Promise.resolve({
            issuer: "fixture",
            subject: "member",
            principal: "member",
          });
        },
      },
    },
    collections: {},
    actions: { action: { id: "fixture", revision: "1" } },
  } satisfies OwnerAuthorization;
  const authority: AuthenticatedAuthority = {
    ...testAuthority(schema, namespace),
    principal: { kind: "session" as const, id: "member" },
    authorityBasis: { kind: "session" as const, id: "session" },
    validity: credentialValidity(new Date(time)),
    ...(withDelivery === "attempt"
      ? {
        principal: {
          kind: "worker" as const,
          id: "attempt",
          executing: "agent",
          initiating: "member",
        },
        authorityBasis: { kind: "attempt" as const, id: "delivery-A" },
        validity: {
          kind: "attempt" as const,
          attempt: "delivery-A",
          worker: "attempt",
          epoch: String(owner.epoch),
        },
      }
      : {}),
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
    eventId: "agent-event",
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
      source: {
        eventId: root.event.id,
        ...(withDelivery === "attempt" ? { operationId: root.event.id } : {}),
      },
      ...(withDelivery === "attempt" ? { operationCatalog: catalog } : {}),
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
    store,
    root,
    action,
    catalog,
    get owner() {
      return owner;
    },
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
      store = makeStore();
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

Deno.test("Processor agent turn: attempt model capabilities reuse capture and report cache misses", async () => {
  const f = await fixture("attempt");
  const counts: Record<string, number> = {};
  const capabilitySql: number[] = [];
  let measuring = false;
  try {
    await f.run("observe", {}, (_, c) => {
      observeAuthorizationCache(c.transaction, (cache, result) => {
        if (measuring) {
          counts[`${cache}.${result}`] = (counts[`${cache}.${result}`] ?? 0) +
            1;
        }
      });
    });
    const coordinator: EventCoordinator = {
      async commitMutation(input) {
        return {
          ...await f.store.commitMutation({ ...input, consumers: [] }),
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
    const lifecycle = createActionLifecycleEmitter({
      namespace: "space",
      append: createActionLifecycleAppender({
        store: f.store,
        coordinator,
        actions: { action: f.action },
        writer: f.writer,
      }),
      load: createActionLifecycleLoader({
        store: f.store,
        actions: { action: f.action },
      }),
    });
    const callers = createActionCallers({ action: f.action }, {
      actionLifecycle: lifecycle,
      prepareInput: f.hooks.prepareInput,
      authorize(frame, _purpose, tx) {
        const authorize = async (transaction: SqlExecutor) => {
          const before = f.statements.length;
          await f.hooks.output(frame).authorize!(transaction);
          if (measuring) capabilitySql.push(f.statements.length - before);
        };
        return tx
          ? authorize(tx)
          : f.run("authorize", {}, (_, c) => authorize(c.transaction));
      },
      createInvocationKey: () => f.frame.actionRunId,
      identity: f.frame.identity,
      signal: f.owner.signal,
      createContext({ actions, frame, progress }) {
        // Zero-latency model stub; each content operation enters a real owner
        // command and the invoker checks authorization again before disclosure.
        measuring = true;
        return {
          actions,
          signal: frame.signal,
          progress,
          content: {
            get: () => f.run("model.content", {}, () => Promise.resolve(null)),
          },
        } as unknown as ActionContext;
      },
    });
    type AgentContext = ProcessorContext<
      Record<string, never>,
      Record<string, never>,
      typeof callers
    >;
    const processor = defineProcessor<AgentContext>(
      {
        id: "agent",
        on: [{ eventType: "test.source" }],
        async handle(_event, context) {
          await context.actions.action({ prompt: "hello" });
        },
      },
    );
    const beforeTurnSql = f.statements.length;
    await processor.handle(
      f.root.event as unknown as ProcessorEvent,
      { actions: callers } as unknown as AgentContext,
    );
    const baseline = Deno.env.get("AUTHZ_REUSE_BASELINE") === "1";
    console.log(
      JSON.stringify({
        agentTurn: {
          capabilities: 26,
          authorizationCalls: capabilitySql.length,
          evaluations: f.evaluations,
          turnSql: f.statements.length - beforeTurnSql,
          counts,
          authorizationSql: capabilitySql.reduce((a, b) => a + b, 0),
          capabilityAuthorizationSql: capabilitySql.slice(0, 78).reduce(
            (a, b) => a + b,
            0,
          ),
          publicationAuthorizationSql: capabilitySql.slice(78).reduce(
            (a, b) => a + b,
            0,
          ),
          sqlPerAuthorization: capabilitySql,
        },
      }),
    );
    if (baseline) {
      assertEquals(f.evaluations, 82);
      assertEquals(counts["action.absent"], 80);
      assertEquals(capabilitySql.slice(0, 78).reduce((a, b) => a + b, 0), 598);
    } else {
      assertEquals(f.evaluations, 1);
      assertEquals(capabilitySql.length, 80); // 78 capability checks + 2 publication checks
      assertEquals(capabilitySql.slice(0, 78), Array(78).fill(0));
      assertEquals(capabilitySql.slice(78), [0, 1]);
      assertEquals(counts["writer.stale"], 1);
      assertEquals(counts["action.hit"], 80);
      assertEquals(counts["action.absent"] ?? 0, 0);
    }
  } finally {
    await f.close();
  }
});

Deno.test("attempt reuse follows renewal and exact delivery/operation changes", async (t) => {
  const f = await fixture("attempt");
  try {
    await f.hooks.prepareInput(f.frame, {});
    assertEquals(await f.call(), 0);
    await t.step(
      "unrelated delivery claim, renew, settle and operation writes preserve both grants",
      async () => {
        const other = await f.store.commitMutation({
          draft: { namespace: "space", type: "other", payload: {} },
          consumers: [{ consumerId: "other", settlement: "inherit" }],
        });
        const id = other.deliveries[0].id;
        await f.store.claimDelivery({ id, owner: "other", leaseMs: 2000 });
        await f.store.heartbeatDeliveries([{
          id,
          owner: "other",
          ownerEpoch: f.owner.epoch!,
          namespace: "space",
          eventId: other.event.id,
          operationId: other.event.id,
          leaseMs: 2000,
        }]);
        await f.store.succeedDelivery(id, "other");
        await f.run(
          "cancel-other",
          {},
          (_, c) =>
            f.catalog.requestCancellation(
              c.transaction,
              "space",
              other.event.id,
              "test",
            ),
        );
        assertEquals(await f.call(), 0);
        assertEquals(f.evaluations, 1);
      },
    );
    await t.step(
      "renewal extends the known lease past the original expiry without policy work",
      async () => {
        f.advance(500);
        assertEquals(
          await f.store.heartbeatDeliveries([{
            id: f.writer!.deliveryId,
            owner: "attempt",
            ownerEpoch: f.owner.epoch!,
            namespace: "space",
            eventId: f.root.event.id,
            operationId: f.root.event.id,
            leaseMs: 2000,
          }]),
          [{ id: f.writer!.deliveryId, owner: "attempt" }],
        );
        f.advance(501);
        assertEquals(await f.call(), 0);
        assertEquals(f.evaluations, 1);
      },
    );
    await t.step(
      "rolled-back settlement does not publish the dead lease",
      async () => {
        await assertRejects(() =>
          f.run("rollback-settlement", {}, async (_, c) => {
            await f.store.succeedDelivery(
              f.writer!.deliveryId,
              "attempt",
              c.transaction,
            );
            await f.hooks.output(f.frame).authorize!(c.transaction);
          })
        );
        await f.call();
        assertEquals(await f.call(), 0);
      },
    );
    await t.step("same operation cancellation refuses next call", async () => {
      await f.run(
        "cancel",
        {},
        (_, c) =>
          f.catalog.requestCancellation(
            c.transaction,
            "space",
            f.root.event.id,
            "test",
          ),
      );
      await assertRejects(() => f.call());
    });
  } finally {
    await f.close();
  }
});

Deno.test("attempt grants die on loss, exact expiry, settlement, reclaim and epoch change", async (t) => {
  for (
    const mode of [
      "loss",
      "expiry",
      "settlement",
      "reclaim",
      "recovery",
      "epoch",
      "raw-write",
      "composed-write",
    ] as const
  ) {
    await t.step(mode, async () => {
      const f = await fixture("attempt");
      try {
        await f.hooks.prepareInput(f.frame, {});
        assertEquals(await f.call(), 0);
        const id = f.writer!.deliveryId;
        if (mode === "loss") {
          await f.store.failDelivery({
            id,
            owner: "attempt",
            error: "lost",
            backoffMs: 0,
          });
        }
        if (mode === "expiry") f.advance(1000);
        if (mode === "settlement") await f.store.succeedDelivery(id, "attempt");
        if (mode === "reclaim") {
          f.advance(1000);
          assertEquals(
            (await f.store.claimDelivery({
              id,
              owner: "attempt-B",
              leaseMs: 2000,
            }))?.leaseOwner,
            "attempt-B",
          );
        }
        if (mode === "recovery") {
          await f.run(
            "exhaust-fixture",
            {},
            (_, c) =>
              c.transaction.query(
                `UPDATE public.event_deliveries SET max_attempts=attempts, lease_expires_at=$2 WHERE id=$1`,
                [id, new Date(0).toISOString()],
              ),
          );
          assertEquals((await f.store.recoverExpiredDeliveries()).length, 1);
        }
        if (mode === "epoch") await f.restart();
        if (mode === "raw-write") {
          await f.run("unknown", {}, (_, c) =>
            c.transaction.query(
              `UPDATE public.event_deliveries SET lease_owner='attempt-B' WHERE id=$1`,
              [id],
            ));
        }
        if (mode === "composed-write") {
          await f.store.commitMutation({
            draft: { namespace: "space", type: "opaque.write", payload: {} },
            consumers: [],
            statement: (param, tables) => ({
              ctes: [],
              gate: "TRUE",
              report: "NULL::jsonb",
              effects: () => [
                `retired AS (UPDATE ${tables.event_deliveries} SET status='cancelled' WHERE id=${
                  param(id)
                } RETURNING id)`,
              ],
              resolve: () => undefined,
            }),
          });
        }
        await assertRejects(() => f.call());
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test("actual evidence reads stay cold; declared unused evidence is reusable", async () => {
  const f = await fixture("attempt");
  try {
    const original = f.policy.evaluate;
    f.policy.evaluate = async (context) => {
      await context.evidence.get("identity");
      return original(context);
    };
    const counts: Record<string, number> = {};
    await f.run("observe", {}, (_, c) => {
      observeAuthorizationCache(c.transaction, (cache, result) => {
        counts[`${cache}.${result}`] = (counts[`${cache}.${result}`] ?? 0) + 1;
      });
    });
    await f.hooks.prepareInput(f.frame, {});
    for (let i = 0; i < 3; i++) await f.call();
    assertEquals(f.evaluations, 4);
    assertEquals(counts["decision.evidence-read"], 4);
    assertEquals(counts["remember.no-reusable-decision"], 4);
  } finally {
    await f.close();
  }
});
