import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { createProtectedValueRuntime } from "./protected-value.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
import { PROTECTED_EFFECT_OUTPUT_SCHEMA } from "./effect-client.ts";
import {
  actionOutputKey,
  readCapturedActionOutput,
} from "./protected-effect-output.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import { createActionEffectController } from "./effects.ts";
import type { ActionContext } from "./types.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
} from "../testing/effect-commit-proxy.ts";

const secretValue = "protected-effect-secret-98274";
const output = {
  ok: true,
  credential: { name: "fixture", token: secretValue },
};
const action = defineAction({
  id: "fixture.protected-output",
  outputSchema: {
    type: "object",
    required: ["ok", "credential"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      credential: {
        type: "object",
        required: ["name", "token"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          token: secret({ type: "string" }),
        },
      },
    },
  } as const,
  execute: () => output,
});
const pgUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
async function fixture(databaseAdapter: boolean | "custom" = false) {
  // An explicitly selected PostgreSQL fixture never constructs PGlite.
  const raw = await createTestDatabase({
    url: pgUrl ?? ":memory:",
    pgPoolMax: 1,
  });
  const sql: string[] = [];
  const traced = (executor: SqlExecutor): SqlExecutor => ({
    query(statement, values) {
      sql.push(statement, JSON.stringify(values));
      return executor.query(statement, values);
    },
  });
  const db = {
    ...raw,
    ...traced(raw),
    transaction:
      (<T>(operation: (transaction: SqlExecutor) => Promise<T>) =>
        raw.transaction((transaction) =>
          operation(traced(transaction))
        )) as SqlSession["transaction"],
  };
  const schema = `protected_effect_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const adapter = await testSecretAdapter();
  let seals = 0;
  let opens = 0;
  const { createDatabaseBodyStore, createDatabaseBodyStoreAdapter } =
    await import(
      "../content/database-body-store.ts"
    );
  const storage = createBodyStorageRuntime(
    databaseAdapter === "custom"
      ? {
        storage: {
          type: "custom",
          config: { store: createDatabaseBodyStore({ session: db, schema }) },
        },
      }
      : databaseAdapter
      ? {
        storage: {
          type: "adapter",
          config: { adapter: createDatabaseBodyStoreAdapter({ session: db }) },
        },
      }
      : {},
  );
  const protectedValues = createProtectedValueRuntime({
    databaseSchema: schema,
    session: db,
    storage,
    adapter: {
      seal(input) {
        seals++;
        return adapter.seal(input);
      },
      open(input) {
        opens++;
        return adapter.open(input);
      },
    },
  });
  const binding = {
    databaseSchema: schema,
    namespace: "space",
    actionRunId: "run",
    action,
    protectedValues,
  };
  let authorized = true;
  const control = new AbortController();
  const client = (
    session: SqlSession = db,
    authorize?: (tx: SqlExecutor) => void,
  ) =>
    createOwnerEffectClient({
      session,
      schema,
      namespace: binding.namespace,
      actionRunId: binding.actionRunId,
      output: { action, protectedValues },
      signal: control.signal,
      authorizeOutput(context) {
        if (!authorized) throw new Error("output slot revoked");
        authorize?.(context.transaction);
      },
    });
  return {
    db,
    sql,
    schema,
    binding,
    protectedValues,
    client,
    control,
    stats: () => ({ seals, opens }),
    revoke: () => {
      authorized = false;
    },
  };
}
Deno.test("protected output confirmation retains one capture, hydrates replay and never persists plaintext", async () => {
  const f = await fixture();
  try {
    let dispatches = 0;
    const invoke = async () => {
      const client = f.client();
      const begun = await client.begin("exchange");
      if (begun.status === "replay") return begun.outcome;
      assertEquals(begun.status, "proceed");
      dispatches++;
      await client.confirmOutput("exchange", output);
      throw new Error("crash after confirm before terminal");
    };
    await assertRejects(invoke, Error, "crash after confirm");
    assertEquals(await invoke(), output);
    await f.client().confirmOutput("exchange", {
      credential: { token: secretValue, name: "fixture" },
      ok: true,
    });
    assertEquals(f.stats().seals, 1);
    assertEquals(dispatches, 1);
    assert(!f.sql.join("\n").includes(secretValue));
    await f.client().begin("second");
    await f.client().confirmOutput("second", output);
    assertEquals(f.stats().seals, 1);
    await assertRejects(
      async () =>
        await f.client().confirmOutput("second", { ...output, ok: false }),
      Error,
      "differs",
    );
    const tables = createCoreTableNames(f.schema);
    for (
      const table of [
        tables.action_effects,
        tables.owner_receipts,
        tables.nodes,
        tables.event_bodies,
      ]
    ) {
      assert(
        !JSON.stringify((await f.db.query(`SELECT * FROM ${table}`)).rows)
          .includes(secretValue),
      );
    }
    assertEquals(
      (await f.db.query(
        `SELECT count(*)::int AS n FROM ${tables.nodes} WHERE type='protected_value'`,
      )).rows[0].n,
      1,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("protected output is captured synchronously and requires the full declared schema", async () => {
  const f = await fixture();
  try {
    const client = f.client();
    await client.begin("exchange");
    const value = structuredClone(output);
    const pending = client.confirmOutput("exchange", value);
    value.credential.token = "changed-after-call";
    await pending;
    assertEquals(await client.inspect("exchange"), {
      status: "replay",
      outcome: output,
    });
    const error = assertThrows(
      () =>
        client.confirmOutput("exchange", {
          credential: { token: secretValue },
        }),
      Error,
    );
    assert(!String(error).includes(secretValue));
    assertThrows(
      () =>
        client.confirm("exchange", {
          schema: PROTECTED_EFFECT_OUTPUT_SCHEMA,
          captureKey: actionOutputKey(f.binding),
        }),
      Error,
      "owner-only",
    );
    assertThrows(
      () => client.confirm("exchange", output),
      Error,
      "confirmOutput",
    );
    const accessor = Object.defineProperty({}, "token", {
      enumerable: true,
      get() {
        throw new Error(secretValue);
      },
    });
    const invalid = assertThrows(
      () => client.confirmOutput("exchange", accessor),
      Error,
    );
    assert(!String(invalid).includes(secretValue));
    assertThrows(
      () =>
        client.confirmOutput("exchange", {
          ...output,
          credential: { name: "fixture", token: "a".repeat(1024 * 1024) },
        }),
      Error,
      "limit",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("protected output replay refuses changed schema, Action, namespace, owner and slot bindings", async () => {
  const f = await fixture();
  try {
    await f.client().begin("exchange");
    await f.client().confirmOutput("exchange", output);
    const captured = (await readCapturedActionOutput(f.db, f.binding))!;
    const changed = [
      { ...f.binding, action: { ...action, id: "fixture.other" } },
      {
        ...f.binding,
        action: {
          ...action,
          outputSchema: { ...action.outputSchema, description: "changed" },
        },
      },
    ];
    for (const binding of changed) {
      await assertRejects(
        () => readCapturedActionOutput(f.db, binding),
        Error,
        "different binding",
      );
    }
    for (
      const coordinates of [
        { namespace: "other", ownerId: `${action.id}:run`, slot: "output" },
        { namespace: "space", ownerId: `${action.id}:other`, slot: "output" },
        { namespace: "space", ownerId: `${action.id}:run`, slot: "input" },
      ]
    ) {
      await assertRejects(() =>
        f.protectedValues.open(coordinates, captured.ref)
      );
    }
    const otherRuntime = createProtectedValueRuntime({
      databaseSchema: `${f.schema}_other`,
      session: f.db,
      storage: createBodyStorageRuntime(),
      adapter: await testSecretAdapter(),
    });
    await assertRejects(() =>
      otherRuntime.open({
        namespace: "space",
        ownerId: `${action.id}:run`,
        slot: "output",
      }, captured.ref)
    );
    const tables = createCoreTableNames(f.schema);
    await createSchemaCommandRunner(f.db, f.schema)(
      "fixture.copy-effect",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `INSERT INTO ${tables.action_effects} (namespace,action_run_id,step,status,ancestors,outcome) SELECT 'other',action_run_id,step,status,ancestors,outcome FROM ${tables.action_effects}`,
        );
      },
    );
    const crossed = createOwnerEffectClient({
      session: f.db,
      schema: f.schema,
      namespace: "other",
      actionRunId: "run",
      output: { action, protectedValues: f.protectedValues },
    });
    await assertRejects(
      () => crossed.inspect("exchange"),
      Error,
      "different binding",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("revoked output authority and cancellation cannot hydrate retained output", async () => {
  const f = await fixture();
  try {
    await f.client().begin("exchange");
    await f.client().confirmOutput("exchange", output);
    const before = f.stats().opens;
    f.revoke();
    await assertRejects(() => f.client().inspect("exchange"), Error, "revoked");
    await assertRejects(() => f.client().begin("exchange"), Error, "revoked");
    assertEquals(f.stats().opens, before);
    f.control.abort();
    await assertRejects(() => f.client().inspect("exchange"));
    assertEquals(f.stats().opens, before);
  } finally {
    await f.db.close();
  }
});
Deno.test("rollback atomically removes accepted capture and effect confirmation", async () => {
  const f = await fixture();
  try {
    let authorizationChecks = 0;
    const client = f.client(f.db, () => {
      if (++authorizationChecks === 3) throw new Error("rollback confirmation");
    });
    await client.begin("exchange");
    await assertRejects(
      () => client.confirmOutput("exchange", output),
      Error,
      "rollback confirmation",
    );
    assertEquals(await f.client().inspect("exchange"), {
      status: "indeterminate",
    });
    assertEquals(await readCapturedActionOutput(f.db, f.binding), undefined);
    assertEquals(
      (await f.db.query(
        `SELECT count(*)::int AS n FROM ${
          createCoreTableNames(f.schema).nodes
        } WHERE type='protected_value'`,
      )).rows[0].n,
      0,
    );
    await f.client().confirmOutput("exchange", output);
    assertEquals(await f.client().inspect("exchange"), {
      status: "replay",
      outcome: output,
    });
  } finally {
    await f.db.close();
  }
});
Deno.test("concurrent protected output confirmations converge on canonical commitment", async () => {
  const f = await fixture();
  try {
    const client = f.client();
    await client.begin("exchange");
    await Promise.all([
      client.confirmOutput("exchange", output),
      client.confirmOutput("exchange", {
        credential: { token: secretValue, name: "fixture" },
        ok: true,
      }),
    ]);
    assertEquals(await client.inspect("exchange"), {
      status: "replay",
      outcome: output,
    });
    assertEquals(
      (await f.db.query(
        `SELECT count(*)::int AS n FROM ${
          createCoreTableNames(f.schema).nodes
        } WHERE type='protected_value'`,
      )).rows[0].n,
      1,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("protected output controller snapshots before asynchronous tracking", async () => {
  let received: unknown;
  const effect = createActionEffectController({
    signal: new AbortController().signal,
    check() {},
    context: () => ({}) as ActionContext,
    track: (start) => Promise.resolve().then(start),
    client: {
      begin: () => Promise.resolve({ status: "proceed" }),
      inspect: () => Promise.resolve({ status: "none" }),
      confirm: () => Promise.resolve(),
      confirmOutput: (_step, value) => {
        received = value;
        return Promise.resolve();
      },
      notStarted: () => Promise.resolve(),
      inventory: () => Promise.resolve([]),
    },
  }).effect;
  const value = structuredClone(output);
  const pending = effect.confirmOutput("exchange", value);
  value.credential.token = "changed";
  await pending;
  assertEquals(received, output);
});
Deno.test({
  name:
    "PostgreSQL lost output COMMIT acknowledgement recovers durable capture without resealing",
  ignore: !pgUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const f = await fixture();
    const proxy = await commitProxy(localPostgresUrl(pgUrl!));
    const proxied = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    try {
      let checks = 0;
      const client = f.client(proxied, () => {
        if (++checks === 2) proxy.arm();
      });
      await client.begin("exchange");
      const pending = client.confirmOutput("exchange", output);
      const rejected = assertRejects(() => pending);
      await bounded(proxy.forwarded, "confirmation COMMIT forwarded");
      assertEquals(
        await bounded(proxy.resolved, "confirmation server COMMIT"),
        "COMMIT",
      );
      proxy.cutClient();
      const error = await bounded(rejected, "uncertain confirmation rejected");
      assertEquals((error as { code?: string }).code, "owner_commit_unknown");
      await assertRejects(() => client.inspect("exchange"));
      // A separate session reacquires the owner epoch and reads both durable facts.
      const nextDb = await createTestDatabase({
        url: localPostgresUrl(pgUrl!),
        pgPoolMax: 4,
      });
      try {
        const recovered = f.client(nextDb);
        assertEquals(await recovered.begin("exchange"), {
          status: "replay",
          outcome: output,
        });
        await recovered.confirmOutput("exchange", output);
        assertEquals(f.stats().seals, 1);
      } finally {
        await nextDb.close();
      }
      assertEquals(proxy.errors, []);
    } finally {
      await proxied.close();
      await proxy.close();
      await f.db.close();
    }
  },
});

Deno.test("replaced delivery attempts cannot replay or confirm another Action output slot", async () => {
  const f = await fixture();
  try {
    const { createEventStore } = await import("../events/store.ts");
    const store = createEventStore({ session: f.db, schema: f.schema });
    const event = await store.append({
      namespace: "space",
      type: "fixture.invoked",
      payload: {},
    }, ["fixture-worker"]);
    const delivery = event.deliveries[0];
    await store.claimDelivery({
      id: delivery.id,
      owner: "first-attempt",
      leaseMs: 60_000,
    });
    const tables = createCoreTableNames(f.schema);
    const command = createSchemaCommandRunner(f.db, f.schema);
    await command("fixture.bind-action", {}, async (_, { transaction }) => {
      await transaction.query(
        `INSERT INTO ${tables.open_actions} (namespace,action_run_id,action_id,scope_id,invoked_event_id,state,owner_delivery_id) VALUES ('space','run',$1,$2,$2,'invoked',$3)`,
        [action.id, event.event.id, delivery.id],
      );
    });
    const bound = (actionId = action.id) =>
      createOwnerEffectClient({
        session: f.db,
        schema: f.schema,
        namespace: "space",
        actionRunId: "run",
        writer: { deliveryId: delivery.id, leaseOwner: "first-attempt" },
        output: {
          action: { ...action, id: actionId },
          protectedValues: f.protectedValues,
        },
      });
    const client = bound();
    await client.begin("exchange");
    await client.confirmOutput("exchange", output);
    const opens = f.stats().opens;
    await assertRejects(
      () => bound("fixture.other").inspect("exchange"),
      Error,
      "inactive Action attempt",
    );
    assertEquals(f.stats().opens, opens);
    await command("fixture.replace-attempt", {}, async (_, { transaction }) => {
      await transaction.query(
        `UPDATE ${tables.event_deliveries} SET lease_owner='replacement' WHERE id=$1`,
        [delivery.id],
      );
    });
    await assertRejects(
      () => client.inspect("exchange"),
      Error,
      "inactive Action attempt",
    );
    await assertRejects(
      () => client.confirmOutput("exchange", output),
      Error,
      "inactive Action attempt",
    );
    assertEquals(f.stats().opens, opens);
  } finally {
    await f.db.close();
  }
});

Deno.test("owner invoker recovery after confirmed output and interrupted terminal dispatches once", async () => {
  const f = await fixture();
  try {
    const { createActionCallers } = await import("./invoker.ts");
    const receipts = new Map<string, import("./types.ts").ActionEventData>();
    let crash = false;
    let dispatches = 0;
    const definition = defineAction({
      ...action,
      async execute(_input: unknown, context: ActionContext) {
        const begun = await context.effect.begin("exchange");
        if (begun.status === "replay") return begun.outcome;
        assertEquals(begun.status, "proceed");
        dispatches++;
        await context.effect.confirmOutput("exchange", output);
        crash = true;
        throw new Error("owner interrupted before terminal");
      },
    });
    const invoke = () =>
      createActionCallers({ run: definition }, {
        actionLifecycle: {
          emit(value) {
            if (crash && value.status !== "invoked") {
              return Promise.reject(
                new Error("owner interrupted before terminal"),
              );
            }
            const prior = receipts.has(value.deduplicationId);
            if (!prior) receipts.set(value.deduplicationId, value);
            return Promise.resolve({ deduplicated: prior } as never);
          },
          invoked: (run) =>
            Promise.resolve(
              receipts.get(
                `${run}:action:invoked`,
              ) as import("./types.ts").ActionInvokedData ?? null,
            ),
          terminal: (run) =>
            Promise.resolve(
              receipts.get(`${run}:action:terminal`) as never ?? null,
            ),
        },
        signal: new AbortController().signal,
        createInvocationKey: () => "protected-recovery",
        createContext: ({ frame }) =>
          ({ signal: frame.signal }) as ActionContext,
        createEffectClient: (frame) =>
          createOwnerEffectClient({
            session: f.db,
            schema: f.schema,
            namespace: "space",
            actionRunId: frame.actionRunId,
            output: { action: definition, protectedValues: f.protectedValues },
            signal: frame.signal,
          }),
      }).run(null);
    await assertRejects(invoke, Error, "interrupted");
    crash = false;
    assertEquals(await invoke(), output);
    assertEquals(dispatches, 1);
    assertEquals(f.stats().seals, 1);
  } finally {
    await f.db.close();
  }
});

Deno.test("protected output transaction reader exposes only ranges and refuses retained use", async () => {
  const f = await fixture();
  try {
    const { createDatabaseBodyStore, databaseBodyStoreReader } = await import(
      "../content/database-body-store.ts"
    );
    await f.client().begin("exchange");
    await f.client().confirmOutput("exchange", output);
    let escaped: ReturnType<typeof databaseBodyStoreReader> | undefined;
    const store = createDatabaseBodyStore({ session: f.db, schema: f.schema });
    await createSchemaCommandRunner(f.db, f.schema)(
      "fixture.reader",
      {},
      (_, { transaction }) => {
        escaped = databaseBodyStoreReader(store, transaction);
        assertEquals(Object.keys(escaped), ["readRange"]);
      },
    );
    await assertRejects(
      () => escaped!.readRange({ bodyId: "unused", offset: 0, end: 0 }),
      Error,
      "active SQL transaction",
    );
  } finally {
    await f.db.close();
  }
});

Deno.test("protected output replay joins a single-connection explicit database adapter", async () => {
  const f = await fixture(true);
  try {
    await f.client().begin("exchange");
    await f.client().confirmOutput("exchange", output);
    assertEquals(await f.client().inspect("exchange"), {
      status: "replay",
      outcome: output,
    });
    await f.client().confirmOutput("exchange", output);
    assertEquals(f.stats().seals, 1);
    assert(!f.sql.join("\n").includes(secretValue));
  } finally {
    await f.db.close();
  }
});

Deno.test("protected output replay preserves scoped reads through a custom database storage wrapper", async () => {
  const f = await fixture("custom");
  try {
    await f.client().begin("exchange");
    await f.client().confirmOutput("exchange", output);
    assertEquals(await f.client().inspect("exchange"), {
      status: "replay",
      outcome: output,
    });
    await f.client().confirmOutput("exchange", output);
    assertEquals(f.stats().seals, 1);
  } finally {
    await f.db.close();
  }
});
