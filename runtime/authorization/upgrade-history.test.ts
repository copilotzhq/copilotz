import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { stableStringify } from "../collections/equal.ts";
import { createAuthorizedActions } from "../actions/authorized-capture.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import {
  abandonmentDecisions,
  recordRetainedTerminals,
  resolveRetainedTerminals,
} from "../actions/upgrade-terminals.ts";
import {
  inspectAuthorityUpgrade,
  iterateAuthorityUpgrade,
  upgradeAuthoritySchema,
} from "./upgrade.ts";
import { upgradeCredentialEffects } from "./credentials-upgrade.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "../actions/persistence.ts";
import { createActionLifecycleEmitter } from "../actions/lifecycle.ts";
import { createActionCallers } from "../actions/invoker.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import type { SqlExecutor } from "../events/session.ts";

async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `authority_history_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const store = createEventStore({ session: db, schema });
  const body = async (id: string, data: unknown, tx: SqlExecutor = db) => {
    const encoded = await encodeEventBody(data);
    await tx.query(
      `INSERT INTO "${schema}".event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES('space',$1,1,$2::jsonb,$3)`,
      [id, encoded.body, encoded.digest],
    );
  };
  return {
    db,
    schema,
    store,
    body,
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
const invoked = (id: string) => ({
  actionId: "synthetic.retired",
  actionRunId: id,
  status: "invoked",
  input: {},
  metadata: {},
});

Deno.test("drained v12 history: own, attested and abandoned runs reach v14 with an empty manifest and cannot execute again", async () => {
  const f = await fixture();
  try {
    const abandoned: Parameters<typeof abandonmentDecisions>[0][number][] = [];
    await f.db.transaction(async (tx) => {
      for (let i = 0; i < 30; i++) {
        for (const kind of ["own", "attested", "abandoned"]) {
          const id = `${kind}-${i}`;
          await f.body(id, invoked(id), tx);
          if (kind === "own") {
            await f.body(`${id}-terminal`, {
              ...invoked(id),
              status: "completed",
              output: "historical",
            }, tx);
          }
          if (kind === "attested") {
            await f.body(`${id}-wrapper`, {
              actionId: "copilotz.server.internal.invoke",
              actionRunId: `${id}-wrapper`,
              status: "completed",
              output: { targetActionRunId: id, status: "completed" },
            }, tx);
          }
          if (kind === "abandoned") {
            abandoned.push({
              namespace: "space",
              runId: id,
              actionId: "synthetic.retired",
              bodyId: id,
            });
          }
        }
      }
    });
    for (let i = 0; i < 3; i++) {
      const event = await f.store.commitMutation({
        draft: {
          namespace: "space",
          type: "copilotz.server.action.requested",
          payload: { synthetic: i },
        },
        consumers: [],
      });
      await f.db.query(
        `INSERT INTO "${f.schema}".event_deliveries(id,event_id,consumer_id,settlement_scope_id,status) VALUES($1,$2,'synthetic',$1,'succeeded')`,
        [`settled-${i}`, event.event.id],
      );
      await f.db.query(
        `INSERT INTO "${f.schema}".copilotz_operations(operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at) VALUES($1,'space',$2,$1,'completed',now(),now())`,
        [`settled-${i}`, event.event.id],
      );
    }
    const owner = await openDatabaseOwner(f.db, f.schema);
    await releaseDatabaseOwner(owner);
    owner.stop();
    await f.db.query(
      `UPDATE "${f.schema}".copilotz_schema_metadata SET version=12`,
    );
    const terminals = await resolveRetainedTerminals(
      f.db,
      f.schema,
      await abandonmentDecisions(abandoned),
    );
    await recordRetainedTerminals(
      f.db,
      f.schema,
      terminals,
      "synthetic-v11-review",
    );
    await f.db.query(
      `ALTER TABLE "${f.schema}".copilotz_schema_metadata ADD COLUMN upgrade_reviewed_fingerprint text`,
    );
    await f.db.query(
      `UPDATE "${f.schema}".copilotz_schema_metadata SET upgrade_reviewed_fingerprint='synthetic-v11-review'`,
    );
    const inventory = await inspectAuthorityUpgrade(f.db, f.schema);
    assertEquals(inventory.invocations, []);
    assertEquals(inventory.events, []);
    assertEquals(inventory.history.counts, { invocations: 90, events: 3 });
    assertEquals(await inspectAuthorityUpgrade(f.db, f.schema), inventory);
    const manifest = { policies: [], invocations: [], events: [] };
    await upgradeAuthoritySchema(f.db, f.schema, manifest);
    const receipt = (await f.db.query<
      {
        intent: { fingerprint: string };
        result: {
          history: { invocations: number; events: number; digest: string };
        };
      }
    >(`SELECT intent,result FROM "${f.schema}".owner_receipts WHERE key='authorization-upgrade:13'`))
      .rows[0];
    assertEquals(receipt.result.history.invocations, 90);
    assertEquals(receipt.result.history.events, 3);
    const hash = async (value: unknown) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(stableStringify(value)),
          ),
        ),
      ].map((b) => b.toString(16).padStart(2, "0")).join("");
    let historyDigest = await hash([]);
    for await (const batch of iterateAuthorityUpgrade(f.db, f.schema)) {
      for (const entry of batch.history) {
        historyDigest = await hash([historyDigest, entry]);
      }
    }
    assertEquals(receipt.result.history.digest, historyDigest);
    const markers =
      (await f.db.query<{ intent: unknown; result: { resumable: boolean } }>(
        `SELECT intent,result FROM "${f.schema}".owner_receipts WHERE kind='authorization.history'`,
      )).rows;
    assertEquals(markers.length, 93);
    for (const marker of markers) {
      assertEquals(marker.intent, receipt.intent);
      assertEquals(marker.result.resumable, false);
    }
    assertEquals(
      (await f.db.query(
        `SELECT * FROM "${f.schema}".authorization_invocations`,
      )).rows,
      [],
    );
    assertEquals(
      (await f.db.query(
        `SELECT * FROM "${f.schema}".owner_receipts WHERE kind='action.protected-input'`,
      )).rows,
      [],
    );
    await upgradeCredentialEffects(f.db, f.schema);
    await upgradeAuthoritySchema(f.db, f.schema, manifest);
    assertEquals(
      (await f.db.query(
        `SELECT version FROM "${f.schema}".copilotz_schema_metadata`,
      )).rows,
      [{ version: 14 }],
    );
    assertEquals(
      (await f.db.query(
        `SELECT intent,result FROM "${f.schema}".owner_receipts WHERE key='authorization-upgrade:13'`,
      )).rows[0],
      receipt,
    );
    const runtimeStore = createEventStore({ session: f.db, schema: f.schema });
    const load = createActionLifecycleLoader({ store: runtimeStore });
    const coordinator = createEventCoordinator({
      store: runtimeStore,
      registry: { durableConsumers: () => [] } as never,
      executor: { scheduleDelivery() {} } as never,
    });
    const append = createActionLifecycleAppender({
      store: runtimeStore,
      coordinator,
    });
    const lifecycle = createActionLifecycleEmitter({
      namespace: "space",
      load,
      append,
    });
    let executions = 0;
    const action = defineAction({
      id: "synthetic.retired",
      execute() {
        executions++;
        return "new";
      },
      resume() {
        executions++;
        return "new";
      },
    });
    for (const runId of ["own-0", "attested-0", "abandoned-0"]) {
      await assertRejects(
        () =>
          lifecycle.emit({
            ...invoked(runId),
            status: "invoked",
            deduplicationId: `${runId}:action:invoked`,
          }),
        Error,
        "no longer owned",
      );
      for (const resume of [false, true]) {
        const callers = createActionCallers({ work: action }, {
          actionLifecycle: lifecycle,
          createInvocationKey: () => runId,
          signal: new AbortController().signal,
          createContext: () => ({} as ActionContext),
          ...(resume
            ? {
              resumption: {
                receipt: {
                  ...invoked(runId),
                  status: "awaiting" as const,
                  handoff: {},
                  operationId: "child",
                  progressIndex: 0,
                },
                outcome: { operationId: "child", status: "completed" as const },
              },
            }
            : {}),
        });
        if (runId.startsWith("abandoned")) {
          await assertRejects(() => callers.work({}));
        } else await callers.work({});
      }
    }
    let evaluations = 0;
    const hooks = createAuthorizedActions({
      actions: { work: action },
      collections: {},
      namespace: "space",
      store: runtimeStore,
      coordinator,
      signal: new AbortController().signal,
      authorization: {
        policies: {
          synthetic: {
            revision: "1",
            sources: [],
            evaluate() {
              evaluations++;
              return { actions: { work: {} } };
            },
          },
        },
        actions: { work: { id: "synthetic", revision: "1" } },
        collections: {},
      },
    });
    const protectedCallers = createActionCallers({ work: action }, {
      actionLifecycle: lifecycle,
      prepareInput: hooks.prepareInput,
      createInvocationKey: () => "own-0",
      signal: new AbortController().signal,
      createContext: () => ({} as ActionContext),
    });
    assertEquals(
      isOwnerAuthorizationRefusal(
        await assertRejects(() => protectedCallers.work({})),
      ),
      true,
    );
    const run = createSchemaCommandRunner(f.db, f.schema);
    await assertRejects(() =>
      run(
        "synthetic.history.observe",
        {},
        (_, { transaction }) =>
          hooks.output({
            actionId: action.id,
            actionRunId: "own-0",
            signal: new AbortController().signal,
          }).authorize!(transaction),
      )
    );
    assertEquals(evaluations, 0);
    assertEquals(executions, 0);
    const changed = await encodeEventBody({
      ...invoked("own-0"),
      status: "completed",
      output: "changed",
    });
    await f.db.query(
      `UPDATE "${f.schema}".event_bodies SET body=$1::jsonb,digest=$2 WHERE event_body_id='own-0-terminal'`,
      [changed.body, changed.digest],
    );
    await assertRejects(
      () => load("space", "own-0:action:terminal"),
      Error,
      "Historical terminal evidence is missing or changed",
    );
    coordinator.close();
  } finally {
    await f.close();
  }
});

Deno.test("authority history stays fail closed for captures, missing sources, ambiguous terminals and pending ingress", async () => {
  const f = await fixture();
  try {
    const source = await f.store.commitMutation({
      draft: {
        namespace: "space",
        type: "copilotz.server.action.requested",
        payload: {},
      },
      consumers: [],
    });
    await f.body("captured", invoked("captured"));
    await f.body("captured-terminal", {
      ...invoked("captured"),
      status: "completed",
    });
    await f.db.query(
      `INSERT INTO "${f.schema}".owner_receipts(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','action.protected-input',$2::jsonb,$3::jsonb)`,
      [
        JSON.stringify(["action.protected-input", "space", "captured"]),
        JSON.stringify({
          databaseSchema: f.schema,
          namespace: "space",
          actionId: "synthetic.retired",
          inputSchema: null,
          publicRevisionFields: [],
        }),
        JSON.stringify({ source: { eventId: source.event.id }, request: {} }),
      ],
    );
    await f.db.query(
      `UPDATE "${f.schema}".copilotz_schema_metadata SET version=12`,
    );
    assertEquals(
      (await inspectAuthorityUpgrade(f.db, f.schema)).invocations.map((i) =>
        i.runId
      ),
      ["captured"],
    );
    await assertRejects(
      () => upgradeAuthoritySchema(f.db, f.schema, { policies: [] }),
      Error,
      "no explicit authority",
    );
    await f.store.commitMutation({
      draft: {
        namespace: "space",
        type: "synthetic.invoked",
        metadata: { sourceEventId: source.event.id },
        payload: {
          dataRef: {
            eventBodyId: "nonterminal",
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
      },
      body: { id: "nonterminal", json: invoked("nonterminal") },
      consumers: [],
    });
    assertEquals(
      (await inspectAuthorityUpgrade(f.db, f.schema)).invocations.map((i) =>
        i.runId
      ).sort(),
      ["captured", "nonterminal"],
    );
    await assertRejects(
      () => upgradeAuthoritySchema(f.db, f.schema, { policies: [] }),
      Error,
      "no explicit authority",
    );
    await f.body("live", invoked("live"));
    await assertRejects(
      () => inspectAuthorityUpgrade(f.db, f.schema),
      Error,
      "Retained invocation source is missing",
    );
    await f.body("live-terminal", {
      ...invoked("live"),
      status: "completed",
      actionId: "different",
    });
    await assertRejects(
      () => inspectAuthorityUpgrade(f.db, f.schema),
      Error,
      "Retained invocation source is missing",
    );
    await f.db.query(
      `DELETE FROM "${f.schema}".event_bodies WHERE event_body_id IN ('live','live-terminal')`,
    );
    await f.db.query(
      `INSERT INTO "${f.schema}".copilotz_operations(operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at) VALUES('pending','space',$1,'pending','running',now(),now())`,
      [source.event.id],
    );
    assertEquals(
      (await inspectAuthorityUpgrade(f.db, f.schema)).events.map((e) =>
        e.eventId
      ),
      [source.event.id],
    );
    await assertRejects(
      () => upgradeAuthoritySchema(f.db, f.schema, { policies: [] }),
      Error,
      "Drain existing work",
    );
    await f.db.query(
      `UPDATE "${f.schema}".copilotz_operations SET state='completed'`,
    );
    await f.db.query(
      `INSERT INTO "${f.schema}".event_deliveries(id,event_id,consumer_id,settlement_scope_id,status) VALUES('pending',$1,'synthetic','pending','pending')`,
      [source.event.id],
    );
    assertEquals(
      (await inspectAuthorityUpgrade(f.db, f.schema)).events.map((e) =>
        e.eventId
      ),
      [source.event.id],
    );
    await assertRejects(
      () => upgradeAuthoritySchema(f.db, f.schema, { policies: [] }),
      Error,
      "deliveries=1",
    );
  } finally {
    await f.close();
  }
});
