import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
} from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import {
  createEventCoordinator,
  type EventCoordinator,
} from "../events/coordinator.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { ActionOwnershipLost, actionOwnershipStatement } from "./ownership.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";
import {
  type PreparedProtectedValue,
  PROTECTED_VALUE_REF_SCHEMA,
} from "./protected-value.ts";

const schema = "owner_local_actions";
const writer = () => ({
  kind: "owner-local" as const,
  deliveryId: "delivery",
  attemptId: "local-attempt",
});
const authority = (transaction: SqlExecutor) => ({
  transaction,
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  commandTime: "2099-01-01T00:00:00.000Z",
  localAttempt: { deliveryId: "delivery", attemptId: "local-attempt" },
});
const input = (run = "run"): ActionLifecycleAppendInput => ({
  draft: {
    type: "work.invoked",
    namespace: "space",
    deduplicationId: `${run}:action:invoked`,
    settlementScopeId: "operation",
  },
  data: {
    actionId: "work",
    actionRunId: run,
    status: "invoked",
    input: null,
    metadata: {},
  },
});

function configuration() {
  const transaction: SqlExecutor = {
    query() {
      assert.fail("Configuration validation must precede SQL");
    },
  };
  const store = {
    tables: { ...createCoreTableNames(schema) },
    session: { ...transaction, transaction: () => assert.fail("No nesting") },
    getEventByDeduplicationId: () => Promise.resolve(null),
  };
  return {
    store,
    schema,
    transaction,
    ownerAuthority: authority(transaction),
    writer: writer(),
    coordinator: {
      commitMutation() {
        assert.fail("Configuration validation must precede body preparation");
      },
      flushCommitted() {
        assert.fail("No publication");
      },
      append() {
        assert.fail("No append");
      },
      recover() {
        assert.fail("No recovery");
      },
    } as EventCoordinator,
  };
}

test("owner-local Action configuration refuses missing or mismatched authority before any work", () => {
  const invalid = [
    { store: undefined },
    { transaction: undefined },
    { ownerAuthority: undefined },
    { schema: undefined },
    { schema: "other_schema" },
    { schema: 'public"; SELECT 1; --' },
    { transaction: { query: () => assert.fail("Wrong transaction") } },
    { commandTime: "2199-01-01T00:00:00.000Z" },
    { writer: { ...writer(), deliveryId: "other" } },
    { writer: { ...writer(), attemptId: "other" } },
  ];
  for (const change of invalid) {
    assert.throws(
      () => createActionLifecycleAppender({ ...configuration(), ...change }),
      /owner-local|schema/i,
    );
  }
  for (
    const change of [
      { localAttempt: undefined },
      { localAttempt: { deliveryId: "other", attemptId: "local-attempt" } },
      { localAttempt: { deliveryId: "delivery", attemptId: "other" } },
      { epoch: 0 },
      { holderId: "" },
      { ownerId: "" },
      { commandTime: "not-a-clock" },
    ]
  ) {
    const options = configuration();
    assert.throws(
      () =>
        createActionLifecycleAppender({
          ...options,
          ownerAuthority: { ...options.ownerAuthority, ...change },
        }),
      /owner-local|timestamp/i,
    );
  }
});

test("owner-local Action statement independently locks epoch then exact NULL-deadline attempt", () => {
  const options = configuration();
  const params: unknown[] = [];
  const statement = actionOwnershipStatement(
    input(),
    options.writer,
    options.store.tables,
    (value) => `$${params.push(value)}`,
    options.ownerAuthority.commandTime,
    { authority: options.ownerAuthority, schema },
  );
  const sql = statement.ctes.join("\n");
  assert.match(sql, /"owner_local_actions"\."owner_epochs"/);
  assert.match(sql, /action_owner_epoch AS MATERIALIZED/);
  assert.match(sql, /owner = \$\d+ AND epoch = \$\d+ AND holder = \$\d+/);
  assert.match(sql, /SELECT 1 FROM action_owner_epoch/);
  assert.match(sql, /status = 'leased' AND lease_owner = \$\d+/);
  assert.match(sql, /lease_expires_at IS NULL/);
  assert.equal(sql.includes("NOW()"), false);
  for (const value of ["owner", 1, "holder", "delivery", "local-attempt"]) {
    assert.ok(params.includes(value));
  }
  assert.throws(() =>
    actionOwnershipStatement(
      input(),
      options.writer,
      createCoreTableNames("other"),
      () => assert.fail("Schema mismatch must precede binding"),
      undefined,
      { authority: options.ownerAuthority, schema },
    ), /schema/i);
});

test("owner-local Action appender snapshots supplied authority and rejects actual-store schema mismatch", async () => {
  const options = {
    ...configuration(),
    actions: { work: { id: "work", execute: () => null } },
  };
  const originalTransaction = options.transaction;
  const params: unknown[] = [];
  let sql = "";
  let committed = 0;
  options.coordinator = {
    ...options.coordinator,
    commitMutation(mutation) {
      assert.equal(this, originalCoordinator);
      committed++;
      assert.equal(mutation.transaction, originalTransaction);
      assert.equal(mutation.dispatch, false);
      assert.deepEqual(mutation.draft.deliveryLease, {
        deliveryId: "delivery",
        owner: "local-attempt",
      });
      sql = mutation.statement!(
        (value) => `$${params.push(value)}`,
        createCoreTableNames(schema),
      ).ctes.join("\n");
      return Promise.resolve({} as never);
    },
  } as typeof options.coordinator;
  const originalCoordinator = options.coordinator;
  const append = createActionLifecycleAppender(options);
  const pending = append(input());
  Object.assign(options.coordinator, {
    commitMutation: () => assert.fail("Changed callback"),
  });
  options.writer.deliveryId = "changed-delivery";
  options.writer.attemptId = "changed-attempt";
  options.ownerAuthority.localAttempt.deliveryId = "changed-delivery";
  options.ownerAuthority.localAttempt.attemptId = "changed-attempt";
  options.ownerAuthority.ownerId = "changed-owner";
  options.ownerAuthority.epoch = 2;
  options.ownerAuthority.holderId = "changed-holder";
  options.ownerAuthority.commandTime = "invalid-clock";
  options.ownerAuthority.transaction = { query: () => assert.fail("Changed") };
  options.transaction = options.ownerAuthority.transaction;
  options.schema = "changed_schema";
  options.store.tables.events = '"changed_schema"."events"';
  options.coordinator = {
    commitMutation: () => assert.fail("Changed"),
  } as never;
  await pending;
  assert.equal(committed, 1);
  assert.match(sql, /"owner_local_actions"\."owner_epochs"/);
  assert.ok(params.includes("local-attempt"));
  assert.equal(
    params.some((value) => String(value).startsWith("changed")),
    false,
  );

  const mismatch = configuration();
  mismatch.coordinator = {
    ...mismatch.coordinator,
    commitMutation(mutation) {
      mutation.statement!(
        () => assert.fail("Must refuse before binding"),
        createCoreTableNames("coordinator_schema"),
      );
      return Promise.resolve({} as never);
    },
  } as typeof mismatch.coordinator;
  await assert.rejects(
    createActionLifecycleAppender(mismatch)(input()),
    /schema/i,
  );
});

test("owner-local Action appender captures protected preparation and adoption callbacks", async () => {
  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared: PreparedProtectedValue = {
    ref: {
      schema: PROTECTED_VALUE_REF_SCHEMA,
      ownerNodeId: "protected-value",
      bodyId: "protected-body",
      storeKind: "database",
      backendId: "database",
      byteLength: 0,
      digest: `sha256:${"0".repeat(64)}`,
      mediaType: "application/vnd.copilotz.action-protected-value+json",
      commitment: "commitment",
      envelope: {},
      protectedUntil: "2099-01-01T00:00:00Z",
    },
  };
  let adopted = 0;
  const protectedValues = {
    async prepare() {
      assert.equal(this, protectedValues);
      entered();
      await ready;
      return prepared;
    },
    adopt() {
      assert.equal(this, protectedValues);
      adopted++;
      return Promise.resolve();
    },
    open() {
      return Promise.reject(new Error("No hydration"));
    },
    project() {
      return Promise.reject(new Error("No projection"));
    },
  };
  const options = {
    ...configuration(),
    protectedValues,
    actions: {
      work: {
        id: "work",
        inputSchema: { type: "string", "x-copilotz-secret": true } as const,
        execute: () => null,
      },
    },
  };
  options.coordinator = {
    ...options.coordinator,
    async commitMutation(mutation) {
      await mutation.mutate!({
        transaction: options.transaction,
        tables: options.store.tables,
      });
      return {} as never;
    },
  };
  const append = createActionLifecycleAppender(options);
  const event = input();
  const pending = append({
    ...event,
    data: { ...event.data, input: "private-input" },
  });
  await preparing;
  protectedValues.prepare = () => Promise.reject(new Error("Changed prepare"));
  protectedValues.adopt = () => Promise.reject(new Error("Changed adoption"));
  release();
  await pending;
  assert.equal(adopted, 1);
  // A second append also uses the captured prepare callback identity.
  await append({ ...event, data: { ...event.data, input: "private-input" } });
  assert.equal(adopted, 2);
});

async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements(schema)) await db.query(sql);
    await db.query(`CREATE TABLE "${schema}".owner_epochs (
      owner TEXT PRIMARY KEY, epoch BIGINT NOT NULL, holder TEXT NOT NULL,
      last_seq BIGINT NOT NULL)`);
    await db.query(
      `INSERT INTO "${schema}".owner_epochs VALUES ('owner',1,'holder',0)`,
    );
    await db.query(`ALTER TABLE "${schema}".events ADD COLUMN owner_id TEXT,
      ADD COLUMN seq BIGINT, ADD CHECK (owner_id IS NOT NULL AND seq IS NOT NULL)`);
    const bound = (
      transaction: SqlExecutor,
      ownerAuthority = authority(transaction),
      localStore = true,
    ) => {
      const store = createEventStore({
        session: db,
        schema,
        ownerCommit: localStore
          ? ownerAuthority
          : { ...ownerAuthority, localAttempt: undefined },
      });
      const coordinator = createEventCoordinator({
        store,
        registry: createPluginRegistry({ plugins: [] }),
        executor: {
          scheduleDelivery() {
            assert.fail("No dispatch before commit");
          },
        } as never,
      });
      return {
        store,
        coordinator,
        schema,
        transaction,
        ownerAuthority,
        writer: writer(),
      };
    };
    await db.transaction(async (tx) => {
      const options = bound(tx);
      const control = createEventStore({
        session: db,
        schema,
        ownerCommit: { ...options.ownerAuthority, localAttempt: undefined },
      });
      const root = await control.commitMutation({
        transaction: tx,
        draft: { type: "source", namespace: "space", payload: {} },
        consumers: [{ consumerId: "worker", settlement: "inherit" }],
      });
      await tx.query(
        `UPDATE "${schema}".event_deliveries SET id = 'delivery',
        status = 'leased', lease_owner = 'local-attempt', lease_expires_at = NULL
        WHERE id = $1`,
        [root.deliveries[0].id],
      );
    });
    const counts = async () =>
      (await db.query(`SELECT
      (SELECT COUNT(*) FROM "${schema}".events)::int AS events,
      (SELECT COUNT(*) FROM "${schema}".event_bodies)::int AS bodies,
      (SELECT COUNT(*) FROM "${schema}".open_actions)::int AS actions,
      (SELECT last_seq FROM "${schema}".owner_epochs)::int AS seq`)).rows[0];
    return { db, bound, counts };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test("owner-local Action database lifecycle ignores elapsed time and rolls back atomically", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const options = f.bound(tx);
      await createActionLifecycleAppender(options)(input());
      const later = {
        ...options.ownerAuthority,
        commandTime: "2199-01-01T00:00:00Z",
      };
      const completed = input();
      await createActionLifecycleAppender(f.bound(tx, later))({
        draft: {
          ...completed.draft,
          type: "work.completed",
          deduplicationId: "run:action:terminal",
        },
        data: { ...completed.data, status: "completed", output: "done" },
      });
    });
    assert.deepEqual(await f.counts(), {
      events: 3,
      bodies: 2,
      actions: 0,
      seq: 3,
    });
    await f.db.transaction(async (tx) => {
      await tx.query("SAVEPOINT failed_local_action");
      await createActionLifecycleAppender(f.bound(tx))(input("savepoint"));
      await tx.query("ROLLBACK TO SAVEPOINT failed_local_action");
    });
    assert.deepEqual(await f.counts(), {
      events: 3,
      bodies: 2,
      actions: 0,
      seq: 3,
    });
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await createActionLifecycleAppender(f.bound(tx))(input("rollback"));
        throw new Error("outer rollback");
      }),
      /outer rollback/,
    );
    assert.deepEqual(await f.counts(), {
      events: 3,
      bodies: 2,
      actions: 0,
      seq: 3,
    });
  } finally {
    await f.db.close();
  }
});

test("owner-local Action database fence rejects stale epochs, holders, deliveries and tokens", async () => {
  const f = await fixture();
  try {
    for (
      const change of [{ epoch: 2 }, { holderId: "stale" }, {
        ownerId: "other",
      }]
    ) {
      await assert.rejects(
        f.db.transaction(async (tx) => {
          const options = f.bound(tx);
          // Use a current EventStore to prove the lifecycle fence is independent.
          await createActionLifecycleAppender({
            ...options,
            ownerAuthority: { ...options.ownerAuthority, ...change },
          })(input("stale"));
        }),
        ActionOwnershipLost,
      );
    }
    for (const change of [{ deliveryId: "wrong" }, { attemptId: "wrong" }]) {
      await assert.rejects(
        f.db.transaction(async (tx) => {
          const options = f.bound(tx);
          await createActionLifecycleAppender({
            ...options,
            writer: { ...options.writer, ...change },
            ownerAuthority: {
              ...options.ownerAuthority,
              localAttempt: {
                ...options.ownerAuthority.localAttempt,
                ...change,
              },
            },
          })(input("wrong-attempt"));
        }),
        ActionOwnershipLost,
      );
    }
    // A NULL lease alone never grants the worker writer owner-local authority.
    await assert.rejects(
      f.db.transaction((tx) => {
        const options = f.bound(tx, authority(tx), false);
        return createActionLifecycleAppender({
          ...options,
          writer: {
            kind: "delivery",
            deliveryId: "delivery",
            leaseOwner: "local-attempt",
          },
        })(input("worker-null"));
      }),
      ActionOwnershipLost,
    );
    await f.db.query(
      `UPDATE "${schema}".event_deliveries SET lease_expires_at = '2299-01-01'`,
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        createActionLifecycleAppender(f.bound(tx))(input("worker-deadline"))
      ),
      ActionOwnershipLost,
    );
    assert.deepEqual(await f.counts(), {
      events: 1,
      bodies: 0,
      actions: 0,
      seq: 1,
    });
  } finally {
    await f.db.close();
  }
});

test("owner-local lifecycle rejects substituted delivery authority before preparation", async () => {
  const options = configuration();
  const append = createActionLifecycleAppender(options);
  const value = input();
  await assert.rejects(
    append({
      ...value,
      draft: {
        ...value.draft,
        deliveryLease: { deliveryId: "other", owner: "local-attempt" },
      },
    }),
    /delivery authority differs/,
  );
});
