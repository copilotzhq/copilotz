import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createRegisteredOwnerExecutionPort } from "../execution/owner-port.ts";
import {
  createRegisteredActionWorker,
  type RegisteredExecutionCompletion,
} from "../execution/registered-worker.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createOwnerActionAdmission,
  OWNER_ACTION_ADMISSION,
  ownerActionAdmissionKey,
  validateOwnerActionAdmissionIdentity,
} from "./admission.ts";
import {
  createOwnerActionResultProjection,
  OWNER_ACTION_RESULT,
  type OwnerActionResultPurpose,
  type OwnerActionResultReference,
} from "./action-result.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommandExecuteOptions,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerExecutionCommands,
  type OwnerExecutionAssignment,
} from "./execution.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const ownerId = "owner";
const namespace = "space";
const now = "2020-01-01T00:00:00.000Z";
const input = { text: "original-input-marker", nested: { value: 7 } };
const output = { text: "ordinary-output-marker", values: [1, null, false] };
const metadata = { label: "private-metadata-marker" };
const provenance = {
  principal: "private-principal-marker",
  route: "fixture.root",
};
const ingress = (): OwnerCaller => ({
  workerId: "ingress",
  ownerEpoch: 1,
  sessionId: "ingress-session",
  authenticated: true,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timeout")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const unavailable = {
  code: "action_result_unavailable",
  message: "Action result is unavailable.",
};
const persisted = [
  "events",
  "event_bodies",
  "event_deliveries",
  "open_actions",
  "owner_receipts",
  "owner_receipt_readers",
  "owner_epochs",
  "copilotz_operations",
  "copilotz_operation_events",
];
async function snapshot(tx: SqlExecutor) {
  return Object.fromEntries(
    await Promise.all(persisted.map(async (table) => [
      table,
      (await tx.query(
        `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
      )).rows,
    ])),
  );
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    f.gate.release.resolve();
    f.owner.stop();
    await f.executor.shutdown();
    await f.db.close();
  }
}
async function setup() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await db.query(`CREATE TABLE fixture_ingress (
    worker_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, namespace TEXT NOT NULL,
    live BOOLEAN NOT NULL, result_granted BOOLEAN NOT NULL, provenance JSONB NOT NULL,
    metadata JSONB NOT NULL)`);
  await db.query(
    `INSERT INTO fixture_ingress VALUES ('ingress','ingress-session',$1,TRUE,TRUE,$2::jsonb,$3::jsonb)`,
    [namespace, JSON.stringify(provenance), JSON.stringify(metadata)],
  );
  const state = {
    callerChecks: 0,
    ingressChecks: 0,
    bodyReads: 0,
    eventReads: 0,
    executions: 0,
    scheduled: [] as OwnerJson[],
    rollback: false,
    outerRollback: false,
    unknownCommit: false,
    gateCommit: false,
    reference: undefined as OwnerActionResultReference | undefined,
    terminalMetadata: undefined as Record<string, unknown> | undefined,
    transactionExecutors: new WeakSet<SqlExecutor>(),
    authorizedExecutors: new WeakSet<SqlExecutor>(),
  };
  const gate = { reached: deferred(), release: deferred() };
  const session: SqlSession = {
    query() {
      throw new Error("ambient session query forbidden");
    },
    async transaction(run) {
      const result = await db.transaction(async (tx) => {
        const wrapped: SqlExecutor = {
          async query<T extends Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) {
            if (/^\s*SELECT/i.test(sql)) {
              if (sql.includes('."event_bodies"')) state.bodyReads++;
              if (sql.includes('."events"')) state.eventReads++;
            }
            if (state.rollback && sql === "RELEASE SAVEPOINT owner_command_0") {
              state.rollback = false;
              throw new Error("injected projection savepoint rollback");
            }
            const result = await tx.query<T>(sql, params);
            if (
              state.terminalMetadata && sql.includes('."events"') &&
              params?.[1] === `${state.reference!.executionId}:action:terminal`
            ) {
              return {
                ...result,
                rows: result.rows.map((row) => ({
                  ...row,
                  metadata: state.terminalMetadata,
                })),
              };
            }
            return result;
          },
        };
        state.transactionExecutors.add(wrapped);
        const value = await run(wrapped);
        if (state.outerRollback) {
          state.outerRollback = false;
          throw new Error("injected outer rollback");
        }
        if (state.gateCommit) {
          gate.reached.resolve();
          await gate.release.promise;
          state.gateCommit = false;
        }
        return value;
      });
      if (state.unknownCommit) {
        state.unknownCommit = false;
        throw Object.assign(new Error("injected unknown COMMIT"), {
          indeterminate: true,
        });
      }
      return result;
    },
  };
  const registry = createPluginRegistry({
    actions: {
      work: defineAction({
        id: "fixture.work",
        inputSchema: { type: "object" } as const,
        outputSchema: { type: "object", required: ["text", "values"] } as const,
        execute() {
          state.executions++;
          return structuredClone(output);
        },
      }),
      other: defineAction({ id: "fixture.other", execute: () => null }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({ session: db });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "processor",
  });
  const admission = createOwnerActionAdmission({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    schedule(ref) {
      state.scheduled.push(ref);
    },
  });
  function assignment(): OwnerExecutionAssignment {
    const ref = state.reference!;
    return {
      ownerId,
      workerId: "worker",
      assignmentId: "assignment",
      sessionId: "worker-session",
      namespace,
      actionId: ref.actionId,
      deliveryId: ref.deliveryId,
      dispatchAttemptId: "attempt",
      ctxGranted: true,
      settlementGranted: true,
      invocation: {
        actionRunId: ref.executionId,
        rootKey: ref.executionId,
        operationKey: `${ref.executionId}/work`,
        metadata,
        identity: { causationId: ref.eventId, settlementScopeId: ref.eventId },
      },
    };
  }
  const execution = createOwnerExecutionCommands({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    executor,
    resolveAssignment(_tx, who) {
      return state.reference && who.workerId === "worker"
        ? assignment()
        : undefined;
    },
    authorizeInput() {},
  });
  const projections = (["action", "http", "operation"] as const).map((
    purpose,
  ) =>
    createOwnerActionResultProjection({
      ownerId,
      schema: "public",
      registry,
      purpose,
      async authorizeCaller(tx, who, ref, time) {
        state.callerChecks++;
        assert.equal(time, now);
        const row = (await tx.query(
          "SELECT * FROM fixture_ingress WHERE worker_id=$1 AND session_id=$2",
          [who.workerId, who.sessionId],
        )).rows[0];
        if (
          !row?.live || who.authenticated !== true ||
          row.namespace !== ref.namespace
        ) {
          throw new Error("private authentication detail");
        }
        state.authorizedExecutors.add(tx);
        // Mutation must not retarget the privately captured reference/caller.
        Object.assign(who, { workerId: "poisoned" });
        Object.assign(ref, { eventId: "poisoned" });
      },
      async authorizeIngress(tx, who, admitted, time) {
        state.ingressChecks++;
        assert.equal(time, now);
        assert.ok(state.authorizedExecutors.has(tx));
        const row = (await tx.query(
          "SELECT * FROM fixture_ingress WHERE worker_id=$1 AND session_id=$2",
          [who.workerId, who.sessionId],
        )).rows[0];
        if (
          !row?.live || !row.result_granted ||
          JSON.stringify(row.provenance) !==
            JSON.stringify(admitted.provenance) ||
          JSON.stringify(row.metadata) !== JSON.stringify(admitted.metadata)
        ) {
          throw new Error("private ingress denial detail");
        }
        Object.assign(admitted.reference, { executionId: "poisoned" });
      },
    })
  );
  const owner = createOwnerCommandBoundary({
    ownerId,
    holderId: "holder",
    schema: "public",
    session,
    now: () => now,
    handlers: {
      [OWNER_ACTION_ADMISSION]: admission.handler,
      ...execution.handlers,
    },
    inputDefinitions: { [OWNER_ACTION_ADMISSION]: admission.inputDefinition },
    projections: {
      ...execution.projections,
      ...Object.fromEntries(projections.map((p) => [p.kind, p.handler])),
    },
    async authorize(tx, who, command, time, normalized) {
      const projection = projections.find((p) => p.kind === command.kind);
      if (projection) return await projection.authorize(tx, who, command, time);
      if (command.kind === OWNER_ACTION_ADMISSION) {
        validateOwnerActionAdmissionIdentity(ownerId, command, normalized);
        assert.equal(who.authenticated, true);
        assert.equal(who.workerId, "ingress");
        assert.deepEqual(normalized.provenance, provenance);
        assert.deepEqual(normalized.metadata, metadata);
        return;
      }
      return await execution.authorize(tx, who, command, time);
    },
    authenticateReceipt(_tx, who) {
      if (!["ingress", "worker"].includes(who.workerId)) {
        throw new Error("receipt denied");
      }
    },
  });
  await owner.acquire(0);
  const admit = async (
    requestId = "request-a",
    space = namespace,
    actionAlias = "work",
  ) => {
    const admitted = await owner.executeInput(ingress(), {
      kind: OWNER_ACTION_ADMISSION,
      domain: "logical",
      key: ownerActionAdmissionKey(ownerId, space, requestId),
      input: {
        namespace: space,
        actionAlias,
        requestId,
        input,
        metadata,
        provenance,
      },
    });
    return admitted.result as OwnerActionResultReference;
  };
  state.reference = await admit();
  const ref = state.reference;
  const workerCaller = (): OwnerCaller => ({
    workerId: "worker",
    ownerEpoch: 1,
    assignmentId: "assignment",
    sessionId: "worker-session",
    dispatchAttemptId: "attempt",
  });
  const port = createRegisteredOwnerExecutionPort({
    ownerId,
    namespace,
    port: {
      execute: (command, options) =>
        owner.execute(workerCaller(), command, options),
      complete: (command, options) =>
        owner.execute(workerCaller(), command, options),
      project: (kind, value, options) =>
        owner.project(workerCaller(), kind, value, options),
      readReceipt: (identity) => owner.readReceipt(workerCaller(), identity),
    },
  });
  const worker = createRegisteredActionWorker({
    registry,
    owner: port,
    createCapabilities: () => ({ resources: {}, adapters: {} }),
  });
  const hint = { assignmentId: "assignment", sessionId: "worker-session" };
  const complete = async (
    completion: RegisteredExecutionCompletion = { status: "completed", output },
  ) => {
    await port.claim(hint, {});
    return await port.complete(
      {
        executionId: ref.executionId,
        deliveryId: ref.deliveryId,
        dispatchAttemptId: "attempt",
      },
      completion,
      {},
    );
  };
  const project = (
    purpose: OwnerActionResultPurpose = "action",
    value: OwnerJson = ref,
    caller = ingress(),
    options?: OwnerCommandExecuteOptions,
  ) =>
    owner.project(
      caller,
      projections[["action", "http", "operation"].indexOf(purpose)].kind,
      value,
      options,
    );
  const terminal = () =>
    createActionLifecycleLoader({ store })(
      namespace,
      `${ref.executionId}:action:terminal`,
    );
  return {
    db,
    owner,
    state,
    gate,
    registry,
    catalog,
    store,
    executor,
    projections,
    ref,
    admit,
    port,
    worker,
    hint,
    complete,
    project,
    terminal,
  };
}

test("Action result is current-authorized terminal output; root operation waits for authoritative settlement", async () => {
  await fixture(async (f) => {
    assert.deepEqual(await f.project(), { status: "pending" });
    const worked = await f.worker.execute(f.hint);
    assert.equal(worked.status, "executed");
    assert.equal(f.state.executions, 1);
    const original = await f.terminal();
    assert.equal(original?.status, "completed");
    assert.deepEqual(original?.input, input);
    assert.deepEqual(original?.metadata, metadata);
    const envelope = await f.store.getEventByDeduplicationId(
      namespace,
      `${f.ref.executionId}:action:terminal`,
    );
    assert.deepEqual({
      ownerId: envelope?.ownerId,
      namespace: envelope?.namespace,
      causationId: envelope?.causationId,
      metadata: envelope?.metadata,
      subject: envelope?.subject,
    }, {
      ownerId,
      namespace,
      causationId: f.ref.eventId,
      metadata: {
        sourceDeliveryId: f.ref.deliveryId,
        actionId: f.ref.actionId,
        actionStatus: "completed",
      },
      subject: { id: f.ref.executionId, type: f.ref.actionId },
    });
    const before = await snapshot(f.db);
    assert.deepEqual(await f.project(), { status: "completed", output });
    assert.deepEqual(await f.project("http"), { status: "completed", output });
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    assert.deepEqual(await snapshot(f.db), before);
    assert.deepEqual(await f.terminal(), original);
    assert.equal(
      await f.catalog.reconcile({ namespace, operationId: f.ref.eventId }),
      1,
    );
    assert.deepEqual(await f.project("operation"), {
      status: "completed",
      output,
    });
    // Projection writes no receipt (the full before/after snapshot above is
    // unchanged). Existing command intent encoding belongs to those commands.
    const receipts = (await f.db.query("SELECT * FROM owner_receipts")).rows;
    const leaked = JSON.stringify(receipts.map((receipt) => receipt.result));
    assert.equal(
      receipts.some((receipt) => String(receipt.kind).includes("result")),
      false,
    );
    for (
      const marker of [
        input.text,
        output.text,
        metadata.label,
        provenance.principal,
      ]
    ) {
      assert.equal(leaked.includes(marker), false);
    }
    const result = await f.project() as { output: { text: string } };
    result.output.text = "caller mutation";
    assert.deepEqual(await f.project(), { status: "completed", output });
    assert.deepEqual(await f.terminal(), original);
  });
});

test("revoked current callers and ingress policy get no result body even with valid receipt recovery", async () => {
  await fixture(async (f) => {
    await f.complete();
    const receipt = await f.port.readCompletion({
      executionId: f.ref.executionId,
      deliveryId: f.ref.deliveryId,
      dispatchAttemptId: "attempt",
    }, {});
    assert.equal(receipt?.status, "completed");
    const before = await snapshot(f.db);
    for (const deny of ["caller", "ingress", "provenance", "metadata"]) {
      await f.db.query(
        "UPDATE fixture_ingress SET live=TRUE,result_granted=TRUE,provenance=$1::jsonb,metadata=$2::jsonb",
        [JSON.stringify(provenance), JSON.stringify(metadata)],
      );
      if (deny === "caller") {
        await f.db.query("UPDATE fixture_ingress SET live=FALSE");
      }
      if (deny === "ingress") {
        await f.db.query("UPDATE fixture_ingress SET result_granted=FALSE");
      }
      if (deny === "provenance") {
        await f.db.query("UPDATE fixture_ingress SET provenance='{}'");
      }
      if (deny === "metadata") {
        await f.db.query("UPDATE fixture_ingress SET metadata='{}'");
      }
      const reads = f.state.bodyReads;
      const events = f.state.eventReads;
      await assert.rejects(f.project(), unavailable);
      assert.equal(f.state.bodyReads, reads);
      if (deny === "caller") assert.equal(f.state.eventReads, events);
      assert.deepEqual(
        await f.port.readCompletion({
          executionId: f.ref.executionId,
          deliveryId: f.ref.deliveryId,
          dispatchAttemptId: "attempt",
        }, {}),
        receipt,
      );
    }
    assert.deepEqual(await snapshot(f.db), before);
  });
});

test("forged namespace, Action, run, source event and delivery references are indistinguishable and read no body", async () => {
  await fixture(async (f) => {
    await f.complete();
    const second = await f.admit("request-b");
    const other = await f.admit("request-c", "other-space", "other");
    const before = await snapshot(f.db);
    const values: OwnerJson[] = [
      null,
      {},
      { ...f.ref, extra: true },
      ...Object.keys(f.ref).map((key) => ({ ...f.ref, [key]: "missing" })),
      { ...f.ref, actionId: "fixture.other" },
      { ...f.ref, eventId: second.eventId },
      { ...f.ref, deliveryId: second.deliveryId },
      { ...f.ref, eventId: second.eventId, deliveryId: second.deliveryId },
      { ...other, namespace },
      { ...f.ref, namespace: " space" },
    ];
    const reads = f.state.bodyReads;
    for (const value of values) {
      await assert.rejects(f.project("action", value), unavailable);
    }
    await assert.rejects(
      f.project("action", f.ref, { ...ingress(), authenticated: false }),
      unavailable,
    );
    await assert.rejects(
      f.project("action", f.ref, { ...ingress(), sessionId: "forged" }),
      unavailable,
    );
    assert.equal(f.state.bodyReads, reads);
    assert.deepEqual(await snapshot(f.db), before);
  });
});

test("safe failure and cancellation stay distinct without raw lifecycle errors", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    await fixture(async (f) => {
      await f.complete({
        status,
        code: status === "failed" ? "action_failed" : "action_cancelled",
      });
      const result = {
        status,
        code: status === "failed" ? "action_failed" : "action_cancelled",
      };
      assert.deepEqual(await f.project(), result);
      assert.deepEqual(await f.project("operation"), { status: "pending" });
      await f.catalog.reconcile({ namespace, operationId: f.ref.eventId });
      assert.deepEqual(await f.project("operation"), result);
      assert.equal(Object.hasOwn(await f.project() as object, "error"), false);
    });
  }
});

test("delivery reports never fabricate a missing terminal completion", async () => {
  await fixture(async (f) => {
    await f.db.query(
      "UPDATE event_deliveries SET status='succeeded' WHERE id=$1",
      [f.ref.deliveryId],
    );
    assert.equal(await f.terminal(), null);
    assert.deepEqual(await f.project(), {
      status: "failed",
      code: "action_not_completed",
    });
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    await f.catalog.reconcile({ namespace, operationId: f.ref.eventId });
    assert.deepEqual(await f.project("operation"), {
      status: "failed",
      code: "action_not_completed",
    });
  });
});

test("HTTP waits only own Action streams; root operation waits all retained settlement obligations", async () => {
  await fixture(async (f) => {
    await f.complete();
    await f.db.query(
      `INSERT INTO copilotz_operation_streams (
      namespace,operation_id,stream_ordinal,stream_id,semantic_stream_id,body_id,descriptor,state
    ) VALUES ($1,$2,1,'own-stream','own-stream','body-own',$3::jsonb,'open'),
      ($1,$2,2,'other-stream','other-stream','body-other',$4::jsonb,'open')`,
      [
        namespace,
        f.ref.eventId,
        JSON.stringify({ metadata: { sourceActionRunId: f.ref.executionId } }),
        JSON.stringify({ metadata: { sourceActionRunId: "descendant-run" } }),
      ],
    );
    assert.deepEqual(await f.project(), { status: "completed", output });
    assert.deepEqual(await f.project("http"), { status: "pending" });
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    assert.equal(
      await f.catalog.reconcile({ namespace, operationId: f.ref.eventId }),
      0,
    );
    await f.db.query(
      `UPDATE copilotz_operation_streams SET state='terminal',outcome='completed',capture='complete',terminal_at=NOW() WHERE stream_id='own-stream'`,
    );
    assert.deepEqual(await f.project("http"), { status: "completed", output });
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    await f.db.query(
      `UPDATE copilotz_operation_streams SET state='terminal',outcome='completed',capture='complete',terminal_at=NOW()`,
    );
    await f.db.query(
      `INSERT INTO event_deliveries (
      id,event_id,consumer_id,settlement_scope_id,status,attempts,max_attempts,available_at,created_at,updated_at
    ) VALUES ('descendant',$1,'processor:descendant',$1,'pending',0,3,NOW(),NOW(),NOW())`,
      [f.ref.eventId],
    );
    assert.deepEqual(await f.project(), { status: "completed", output });
    assert.deepEqual(await f.project("http"), { status: "completed", output });
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    assert.equal(
      await f.catalog.reconcile({ namespace, operationId: f.ref.eventId }),
      0,
    );
    await f.db.query(
      "UPDATE event_deliveries SET status='succeeded' WHERE id='descendant'",
    );
    // A drain alone must never be mistaken for the authoritative settled state.
    assert.deepEqual(await f.project("operation"), { status: "pending" });
    assert.equal(
      await f.catalog.reconcile({ namespace, operationId: f.ref.eventId }),
      1,
    );
    assert.deepEqual(await f.project("operation"), {
      status: "completed",
      output,
    });
    // Even an inconsistent externally written terminal scope cannot expose output
    // while retained obligations are still live.
    await f.db.query(
      "UPDATE event_deliveries SET status='pending' WHERE id='descendant'",
    );
    assert.deepEqual(await f.project("operation"), { status: "pending" });
  });
});

test("current protected, content and deferred Action definitions refuse before result body lookup", async () => {
  await fixture(async (f) => {
    await f.complete();
    const actions = f.registry.actions as Record<string, AnyActionDefinition>;
    const original = actions.work;
    const before = await snapshot(f.db);
    const definitions: AnyActionDefinition[] = [
      defineAction({
        id: original.id,
        inputSchema: { type: "string", "x-copilotz-secret": true } as const,
        execute: () => null,
      }),
      defineAction({
        id: original.id,
        outputSchema: {
          type: "object",
          properties: { value: { type: "string", "x-copilotz-secret": true } },
        } as const,
        execute: () => null,
      }),
      defineAction({
        id: original.id,
        content: { input: ["attachments"] },
        execute: () => null,
      }),
      { ...original, resolve: () => null } as AnyActionDefinition,
    ];
    for (const definition of definitions) {
      actions.work = definition;
      const reads = f.state.bodyReads;
      await assert.rejects(f.project(), {
        code: "action_capability_unsupported",
      });
      assert.equal(f.state.bodyReads, reads);
      await assert.rejects(
        f.project("action", { ...f.ref, eventId: "missing" }),
        unavailable,
      );
    }
    actions.work = original;
    assert.deepEqual(await f.project(), { status: "completed", output });
    assert.deepEqual(await snapshot(f.db), before);
  });
});

test("historical protected and content bodies are refused despite an ordinary current definition", async () => {
  await fixture(async (f) => {
    await f.complete();
    const original = await f.terminal();
    const bodyId =
      `event-body:${namespace}:${f.ref.executionId}:action:terminal`;
    const bodies = [
      {
        schema: "copilotz.action.lifecycle.protected.v1",
        data: original,
        protected: { output: { schema: "copilotz.action.protected-value.v1" } },
      },
      {
        ...original,
        output: {
          nested: [{
            assetId: "asset",
            kind: "text",
            role: "body",
            mediaType: "text/plain",
          }],
        },
      },
      {
        ...original,
        output: {
          nested: {
            schema: "copilotz.action.protected-value.v1",
            bodyId: "sealed",
          },
        },
      },
      {
        ...original,
        input: [{
          assetId: "asset",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
          resolve: false,
        }],
      },
    ];
    (f.registry.actions as Record<string, AnyActionDefinition>).work =
      defineAction({ id: f.ref.actionId, execute: () => null });
    for (const body of bodies) {
      const encoded = await encodeEventBody(body);
      await f.db.query(
        "UPDATE event_bodies SET body=$1::jsonb,digest=$2 WHERE namespace=$3 AND event_body_id=$4",
        [encoded.body, encoded.digest, namespace, bodyId],
      );
      const before = await snapshot(f.db);
      await assert.rejects(f.project(), unavailable);
      assert.deepEqual(await snapshot(f.db), before);
    }
  });
});

test("terminal envelope and lifecycle identity are exact and failures do not reveal corrupt data", async () => {
  await fixture(async (f) => {
    await f.complete();
    const original = await f.terminal();
    const terminalId = `${f.ref.executionId}:action:terminal`;
    const bodyId = `event-body:${namespace}:${terminalId}`;
    const event = await f.store.getEventByDeduplicationId(
      namespace,
      terminalId,
    );
    const reads = f.state.bodyReads;
    for (
      const change of [
        { ...event!.metadata, sourceDeliveryId: "unrelated" },
        { ...event!.metadata, actionId: "fixture.other" },
      ]
    ) {
      f.state.terminalMetadata = change;
      await assert.rejects(f.project(), unavailable);
      assert.equal(f.state.bodyReads, reads);
    }
    f.state.terminalMetadata = undefined;
    for (
      const body of [
        { ...original, actionRunId: "unrelated" },
        { ...original, actionId: "fixture.other" },
        { ...original, parentActionRunId: "unrelated" },
        { ...original, status: "invoked" },
        { ...original, output: "violates current output schema" },
      ]
    ) {
      const encoded = await encodeEventBody(body);
      await f.db.query(
        "UPDATE event_bodies SET body=$1::jsonb,digest=$2 WHERE namespace=$3 AND event_body_id=$4",
        [encoded.body, encoded.digest, namespace, bodyId],
      );
      await assert.rejects(f.project(), unavailable);
    }
  });
});

test("projection module requires both current policy hooks and cannot bypass the boundary authorizer", async () => {
  await fixture(async (f) => {
    const config = {
      ownerId,
      schema: "public",
      registry: f.registry,
      purpose: "action" as const,
      authorizeCaller() {},
      authorizeIngress() {},
    };
    for (const name of ["authorizeCaller", "authorizeIngress"] as const) {
      assert.throws(
        () =>
          createOwnerActionResultProjection(
            { ...config, [name]: undefined } as unknown as Parameters<
              typeof createOwnerActionResultProjection
            >[0],
          ),
        /current host authorization/,
      );
    }
    assert.throws(
      () =>
        createOwnerActionResultProjection(
          { ...config, purpose: undefined } as unknown as Parameters<
            typeof createOwnerActionResultProjection
          >[0],
        ),
      /explicit purpose/,
    );
    await assert.rejects(
      Promise.resolve(f.projections[0].handler(f.ref, {
        tx: f.db,
        caller: ingress(),
        commandTime: now,
        signal: new AbortController().signal,
      })),
      unavailable,
    );
    await assert.rejects(
      f.owner.execute(ingress(), {
        kind: OWNER_ACTION_RESULT,
        domain: "occurrence",
        key: "bypass",
        intent: f.ref,
      }),
      { code: "owner_command_invalid" },
    );
  });
});

for (const failure of ["rollback", "outerRollback", "unknownCommit"] as const) {
  test(`projection ${failure} suppresses ephemeral output and creates no plaintext receipt`, async () => {
    await fixture(async (f) => {
      await f.complete();
      const before = await snapshot(f.db);
      f.state[failure] = true;
      let exposed = false;
      await assert.rejects(
        f.project().then((value) => {
          exposed = true;
          return value;
        }),
        /injected|outcome|commit/i,
      );
      assert.equal(exposed, false);
      assert.deepEqual(await snapshot(f.db), before);
      if (failure === "rollback") {
        assert.deepEqual(await f.project(), { status: "completed", output });
      } else assert.equal(f.owner.state, "stopped");
    });
  });
}

for (const retire of ["abort", "stop", "none"] as const) {
  test(`projection output remains behind outer commit and ${retire} preserves scope lifetime`, async () => {
    await fixture(async (f) => {
      await f.complete();
      const before = await snapshot(f.db);
      f.state.gateCommit = true;
      const abort = new AbortController();
      let exposed = false;
      const pending = f.project("action", f.ref, ingress(), {
        signal: abort.signal,
      }).then((value) => {
        exposed = true;
        return value;
      });
      await within(f.gate.reached.promise);
      assert.equal(exposed, false);
      if (retire === "abort") abort.abort(new Error("projection cancelled"));
      if (retire === "stop") f.owner.stop(new Error("owner stopped"));
      const rejected = retire === "none"
        ? undefined
        : assert.rejects(pending, /cancelled|stopped/);
      f.gate.release.resolve();
      if (rejected) {
        await within(rejected);
        assert.equal(exposed, false);
      } else {assert.deepEqual(await within(pending), {
          status: "completed",
          output,
        });}
      assert.deepEqual(await snapshot(f.db), before);
    });
  });
}
