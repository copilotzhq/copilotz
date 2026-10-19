import { createMemoryBodyStore } from "../content/body-store.ts";
import { createContentCatalog } from "../content/catalog.ts";
import type { BodyStorageRuntime } from "../content/body-store.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { createProtectedValueRuntime } from "./protected-value.ts";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import { createAuthorizedActions } from "./authorized-capture.ts";
import { defineCollection } from "../collections/definition.ts";
import { testAuthority } from "../testing/authority.ts";
import { authorityIngressProof } from "../application/ingress/authority.ts";
import type { OwnerPolicy } from "../authorization/evaluator.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
  until,
} from "../testing/effect-commit-proxy.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const token = "owner-prepared-secret-28173";
const candidate = "owner-candidate-secret-89413";
const output = { ok: true, token: candidate };
const protectedAction = (publicOutput = false) =>
  defineAction({
    id: "fixture.protected",
    inputSchema: {
      type: "object",
      required: ["account"],
      additionalProperties: false,
      properties: {
        account: { type: "string" },
        credential: secret({ type: "string" }),
        credentialRevision: { type: ["string", "null"] },
      },
    } as const,
    outputSchema: publicOutput
      ? {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
        additionalProperties: false,
      }
      : {
        type: "object",
        required: ["ok", "token"],
        properties: {
          ok: { type: "boolean" },
          token: secret({ type: "string" }),
        },
        additionalProperties: false,
      },
    execute: (input: unknown) => input,
  });
const frame = (
  run = "run",
  signal = new AbortController().signal,
): ActionInvocationFrame => ({
  actionId: "fixture.protected",
  actionRunId: run,
  rootKey: run,
  operationKey: run,
  metadata: { actor: "forged", sourceEventId: "forged" },
  signal,
  nextActionIndex: () => 1,
});
async function fixture(
  publicOutput = false,
  supplied?: { db: TestDatabase; schema: string; storage?: BodyStorageRuntime },
) {
  const db = supplied?.db ??
    await createTestDatabase({ url: url ?? ":memory:", pgPoolMax: 1 });
  const schema = supplied?.schema ??
    `protected_hooks_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const store = createEventStore({ session: db, schema });
  const source = await store.commitMutation({
    draft: {
      namespace: "space",
      type: "fixture.request",
      payload: {
        dataRef: {
          eventBodyId: `source:${schema}`,
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
      metadata: { principal: "member" },
    },
    body: {
      id: `source:${schema}`,
      json: { account: "account-a", principal: "member" },
    },
    consumers: [],
    ingress: authorityIngressProof(testAuthority(schema)),
  });
  await createSchemaCommandRunner(db, schema)(
    "fixture.member",
    {},
    async (_, ctx) => {
      await ctx.transaction.query(
        `INSERT INTO "${schema}".nodes(id,namespace,type,name) VALUES('member','space','member','member')`,
      );
    },
  );
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({
          ...input,
          consumers: [],
          onCommitted() {
          },
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
  const adapter = await testSecretAdapter();
  let seals = 0;
  let prepared = 0;
  let authorized = 0;
  const protectedValues = createProtectedValueRuntime({
    databaseSchema: schema,
    session: db,
    storage: supplied?.storage ?? createBodyStorageRuntime({}),
    adapter: {
      seal(input) {
        seals++;
        return adapter.seal(input);
      },
      open: adapter.open,
    },
  });
  const action = protectedAction(publicOutput);
  const member = defineCollection({
    name: "member",
    schema: { type: "object", properties: { id: { type: "string" } } },
  });
  let leaked: Parameters<OwnerPolicy["evaluate"]>[0] | undefined;
  const definition: OwnerPolicy = {
    revision: "1",
    sources: ["member"],
    async evaluate(context) {
      authorized++;
      leaked = context;
      assertEquals(context.authority.principal.id, "member");
      if (!await context.read.get("member", "member")) {
        throw new Error("Owner authorization could not be completed");
      }
      if (
        (context.intent.input as { account: string }).account !== "account-a"
      ) throw new Error("Owner authorization could not be completed");
      if (context.intent.operation === "capture") {
        prepared++;
        return {
          actions: {
            action: { input: { credential: token, credentialRevision: "r1" } },
          },
        };
      }
      return { actions: { action: {} } };
    },
  };
  const build = (
    override: Partial<OwnerPolicy> = {},
    session: SqlSession = db,
    currentProtectedValues = protectedValues,
  ) => {
    const currentStore = session === db
      ? store
      : createEventStore({ session, schema });
    const currentCoordinator = session === db ? coordinator : {
      ...coordinator,
      async commitMutation(input) {
        return {
          ...await currentStore.commitMutation({ ...input, consumers: [] }),
          dispatch: { handles: [], failures: [] },
        };
      },
    } as EventCoordinator;
    return createAuthorizedActions({
      authorization: {
        policies: { fixture: { ...definition, ...override } },
        actions: { action: { id: "fixture", revision: "1" } },
        collections: {},
      },
      collections: { member },
      actions: { action },
      store: currentStore,
      coordinator: currentCoordinator,
      namespace: "space",
      source: { eventId: source.event.id },
      signal: new AbortController().signal,
      protectedValues: currentProtectedValues,
    });
  };
  const hooks = build();
  const client = (f = frame(), current = hooks, session: SqlSession = db) =>
    createOwnerEffectClient({
      session,
      schema,
      namespace: "space",
      actionRunId: f.actionRunId,
      action,
      authorize: current.output(f).authorize,
      signal: f.signal,
    });
  const complete = (
    f = frame(),
    value: unknown = publicOutput ? { ok: true } : output,
    current = hooks,
  ) =>
    createActionLifecycleAppender({
      store,
      coordinator,
      actions: { action },
      protectedValues,
      protectedActionOutput: () => current.output(f),
    })({
      draft: {
        namespace: "space",
        type: `${action.id}.completed`,
        subject: { type: action.id, id: f.actionRunId },
        metadata: { actionId: action.id, actionStatus: "completed" },
        deduplicationId: `${f.actionRunId}:action:terminal`,
      },
      data: {
        status: "completed",
        actionId: action.id,
        actionRunId: f.actionRunId,
        metadata: f.metadata,
        input: {
          account: "account-a",
          credential: token,
          credentialRevision: "r1",
        },
        output: value,
      },
    });
  return {
    db,
    schema,
    adapter,
    store,
    coordinator,
    action,
    source,
    protectedValues,
    hooks,
    build,
    client,
    complete,
    stats: () => ({ prepared, authorized, seals }),
    leaked: () => leaked!,
    async count(type: string) {
      return Number(
        (await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${schema}".nodes WHERE type=$1`,
          [type],
        )).rows[0].n,
      );
    },
    async revoke() {
      await createSchemaCommandRunner(db, schema)(
        "fixture.revoke",
        {},
        async (_, ctx) => {
          await ctx.transaction.query(
            `DELETE FROM "${schema}".nodes WHERE type='member'`,
          );
        },
      );
    },
  };
}
Deno.test("protected input preparation captures once, refuses forged account, reauthorizes replay and revokes handles", async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () => f.hooks.prepareInput(frame("forged"), { account: "other" })!,
      Error,
      "Owner authorization could not be completed",
    );
    const raw = { account: "account-a" };
    const pending = f.hooks.prepareInput(frame(), raw)!;
    raw.account = "forged";
    const first = await bounded(pending, "prepare input");
    assertEquals(first, {
      input: {
        account: "account-a",
        credential: token,
        credentialRevision: "r1",
      },
      claimed: true,
      metadata: { actor: "forged", sourceEventId: "forged" },
    });
    assertEquals(
      (await f.hooks.prepareInput(frame(), {
        account: "account-a",
        credential: "ignored",
      })!).input,
      first.input,
    );
    assertEquals(f.stats().prepared, 1);
    assertEquals(f.stats().seals, 1);
    assertThrows(() => f.leaked().read.get("member", "member"), Error, "ended");
    await f.revoke();
    await assertRejects(
      () => f.hooks.prepareInput(frame(), { account: "account-a" })!,
      Error,
      "Owner authorization could not be completed",
    );
    assertEquals(f.stats().prepared, 1);
  } finally {
    await f.db.close();
  }
});
Deno.test("synchronous protected callbacks lose query authority before their scheduled microtask", async () => {
  const f = await fixture();
  try {
    let late: Promise<unknown> | undefined;
    let rejected = false;
    const hooks = f.build({
      evaluate(context) {
        queueMicrotask(() => {
          try {
            late = context.read.get("member", "member");
          } catch (error) {
            late = Promise.reject(error);
          }
          void late?.catch(() => undefined);
        });
        return {
          actions: {
            action: { input: { credential: token, credentialRevision: "r1" } },
          },
        };
      },
    });
    await hooks.prepareInput(frame(), { account: "account-a" });
    await late?.catch(() => {
      rejected = true;
    });
    assertEquals(rejected, true);
  } finally {
    await f.db.close();
  }
});
Deno.test("protected preparation joins the current owner transaction and rolls back capture with its caller", async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        createSchemaCommandRunner(f.db, f.schema)(
          "fixture.join",
          {},
          async (_, command) => {
            await f.hooks.prepareInput(
              frame(),
              { account: "account-a" },
              command.transaction,
            );
            throw new Error("rollback caller");
          },
        ),
      Error,
      "rollback caller",
    );
    assertEquals(
      (await f.db.query(
        `SELECT key FROM "${f.schema}".owner_receipts WHERE kind='action.protected-input'`,
      )).rows,
      [],
    );
    await f.hooks.prepareInput(frame(), { account: "account-a" });
    assertEquals(f.stats().prepared, 2);
  } finally {
    await f.db.close();
  }
});
Deno.test({
  name:
    "real lost COMMIT during input capture replays the first preparation without repeating it",
  ignore: !url,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const proxy = await commitProxy(url!);
    const proxied = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    const remote = createMemoryBodyStore({ backendId: "lost-external" });
    let remoteWrites = 0;
    const storage = createBodyStorageRuntime({
      storage: {
        type: "custom",
        config: {
          store: {
            ...remote,
            put(input) {
              remoteWrites++;
              return remote.put(input);
            },
          },
        },
      },
    });
    const f = await fixture(false, {
      storage,
      db: proxied,
      schema: `input_lost_${crypto.randomUUID().replaceAll("-", "")}`,
    });
    let nextDb: TestDatabase | undefined;
    let preparations = 0;
    try {
      const hooks = f.build({
        evaluate(context) {
          if (context.intent.operation === "capture") {
            preparations++;
            proxy.arm();
            return {
              actions: {
                action: {
                  input: { credential: token, credentialRevision: "r1" },
                },
              },
            };
          }
          return { actions: { action: {} } };
        },
      });
      const pending = hooks.prepareInput(frame(), { account: "account-a" })!;
      const rejected = assertRejects(() => pending);
      await bounded(proxy.forwarded, "input COMMIT forwarded");
      assertEquals(
        await bounded(proxy.resolved, "input COMMIT resolved"),
        "COMMIT",
      );
      proxy.cutClient();
      assertEquals(
        (await bounded(rejected, "unknown input commit") as { code?: string })
          .code,
        "owner_commit_unknown",
      );
      nextDb = await createTestDatabase({
        url: localPostgresUrl(url!),
        pgPoolMax: 1,
      });
      assertEquals(remoteWrites, 0);
      const recoveredValues = createProtectedValueRuntime({
        databaseSchema: f.schema,
        session: nextDb,
        storage,
        adapter: f.adapter,
      });
      const replay = await f.build({}, nextDb, recoveredValues).prepareInput(
        frame(),
        {
          account: "account-a",
          credential: "changed",
        },
      );
      assertEquals(replay, {
        claimed: false,
        metadata: { actor: "forged", sourceEventId: "forged" },
        input: {
          account: "account-a",
          credential: token,
          credentialRevision: "r1",
        },
      });
      const recoveredCatalog = createContentCatalog(nextDb, f.schema);
      const bodyId = (await nextDb.query<{ id: string }>(
        `SELECT data->>'bodyId' AS id FROM "${f.schema}".nodes WHERE type='protected_value'`,
      )).rows[0].id;
      await until(
        async () =>
          (await recoveredCatalog.read(bodyId))?.copy.backendId ===
              remote.backendId
            ? true
            : undefined,
        "recovered input promotes after replay commit",
      );
      assertEquals(remoteWrites, 1);
      assertEquals(preparations, 1);
      assertEquals(f.stats().prepared, 0);
      assertEquals(proxy.errors, []);
    } finally {
      await proxy.close();
      await nextDb?.close();
      await proxied.close();
    }
  },
});
Deno.test("transactional protected input uses committed database staging and existing promotion with read fallback", async () => {
  const db = await createTestDatabase({ url: url ?? ":memory:", pgPoolMax: 1 });
  const schema = `promoted_hook_${crypto.randomUUID().replaceAll("-", "")}`;
  const remote = createMemoryBodyStore({ backendId: "fixture-external" });
  let writes = 0, available = false;
  const external = {
    ...remote,
    head(input: Parameters<typeof remote.head>[0]) {
      if (!available) return Promise.reject(new Error("external unavailable"));
      return remote.head(input);
    },
    async put(input: Parameters<typeof remote.put>[0]) {
      writes++;
      assert(!(new TextDecoder().decode(input.bytes)).includes(token));
      assertEquals(
        Number(
          (await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM "${schema}".owner_receipts WHERE kind='action.protected-input'`,
          )).rows[0].n,
        ),
        1,
      );
      const head = await remote.put(input);
      if (!available) throw new Error("external acknowledgement lost");
      return head;
    },
  };
  const storage = createBodyStorageRuntime({
    storage: { type: "custom", config: { store: external } },
  });
  const f = await fixture(false, { db, schema, storage });
  const catalog = createContentCatalog(db, schema);
  try {
    await assertRejects(
      () =>
        createSchemaCommandRunner(db, schema)(
          "fixture.rollback",
          {},
          async (_, command) => {
            await f.hooks.prepareInput(
              frame(),
              { account: "account-a" },
              command.transaction,
            );
            assertEquals(writes, 0);
            throw new Error("rollback");
          },
        ),
      Error,
      "rollback",
    );
    assertEquals(writes, 0);
    assertEquals(
      (await db.query(`SELECT body_id FROM "${schema}".content_logical_bodies`))
        .rows,
      [],
    );
    await f.hooks.prepareInput(frame(), { account: "account-a" });
    await until(
      () => writes > 0 ? true : undefined,
      "post-commit external attempt",
    );
    const bodyId = (await db.query<{ id: string }>(
      `SELECT data->>'bodyId' AS id FROM "${schema}".nodes WHERE type='protected_value'`,
    )).rows[0].id;
    await until(
      async () =>
        (await catalog.read(bodyId))?.promotionTarget ? undefined : true,
      "failed promotion finishes",
    );
    assertEquals((await catalog.read(bodyId))?.copy.backendKind, "database");
    const orphans = await db.query<{ key: string }>(
      `SELECT copy_key AS key FROM "${schema}".content_copies WHERE state='orphan'`,
    );
    assert(orphans.rows.length > 0);
    assert(await remote.head({ bodyId: orphans.rows[0].key }));
    assertEquals(
      (await f.hooks.prepareInput(frame(), { account: "account-a" }))?.input,
      { account: "account-a", credential: token, credentialRevision: "r1" },
    );
    available = true;
    await f.hooks.prepareInput(frame(), { account: "account-a" });
    await until(
      async () =>
        (await catalog.read(bodyId))?.copy.backendId === remote.backendId
          ? true
          : undefined,
      "existing promotion accepted",
    );
    assertEquals(
      (await f.hooks.prepareInput(frame(), { account: "account-a" }))?.input,
      { account: "account-a", credential: token, credentialRevision: "r1" },
    );
    assertEquals(f.stats().prepared, 2);
    assertEquals((await catalog.read(bodyId))?.bodyId, bodyId);
  } finally {
    await db.close();
  }
});

import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { ActionError } from "./errors.ts";
Deno.test("protected policy cannot turn a query infrastructure failure into permanent refusal", async () => {
  const f = await fixture();
  try {
    const hooks = f.build({
      async evaluate(context) {
        try {
          await context.read.get("undeclared", "missing");
        } catch {
          throw new ActionError("wrapped denial", {
            code: "forbidden",
            status: 403,
          });
        }
        return { actions: { action: {} } };
      },
    });
    const error = await assertRejects(() =>
      hooks.prepareInput(frame(), { account: "account-a" })!
    );
    assertEquals(isOwnerAuthorizationRefusal(error), false);
    await f.build().prepareInput(frame(), { account: "account-a" });
  } finally {
    await f.db.close();
  }
});
