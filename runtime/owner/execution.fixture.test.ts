import assert from "node:assert/strict";
import { defineAction } from "../actions/define.ts";
import type { ActionContext, AnyActionDefinition } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createRegisteredOwnerExecutionPort,
  ownerClaimKey,
  ownerCompletionKey,
} from "../execution/owner-port.ts";
import {
  createRegisteredActionWorker,
  type RegisteredExecutionCompletion,
} from "../execution/registered-worker.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import { defineProcessor } from "../plugins/processor.ts";
import {
  createOperationCatalog,
  type OperationSettlementScope,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { defineView } from "../views/index.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandContext,
  type OwnerJson,
} from "./boundary.ts";
import { createOwnerCollectionCommand } from "./collections.ts";
import {
  createOwnerExecutionCommands,
  type OwnerExecutionAssignment,
} from "./execution.ts";
import { createOwnerEffectCommands } from "./effects.ts";
import { createOwnerEffectClient } from "./effects-client.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

export const start = "2020-01-01T00:00:00.000Z";
export const at = (offset: number) =>
  new Date(Date.parse(start) + offset).toISOString();
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture timed out")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function snapshot(tx: SqlExecutor) {
  return Object.fromEntries(
    await Promise.all([
      "event_deliveries",
      "events",
      "event_bodies",
      "open_actions",
      "nodes",
      "owner_receipts",
      "owner_receipt_readers",
      "owner_epochs",
    ].map(async (
      table,
    ) => [
      table,
      (await tx.query(
        `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
      )).rows,
    ])),
  );
}

export async function fixture(
  input: {
    action?: AnyActionDefinition;
    inline?: boolean;
    sourceInput?: OwnerJson;
    inputPolicy?: Parameters<
      typeof createOwnerExecutionCommands
    >[0]["authorizeInput"];
    allowRecovery?: Parameters<
      typeof createOwnerExecutionCommands
    >[0]["allowRecovery"];
    now?(): string;
    afterAction?(ctx: ActionContext): void | Promise<void>;
    scheduleSettlement?(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
    validateCaller?(tx: SqlExecutor, caller: OwnerCaller): void | Promise<void>;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await db.query(
    `CREATE TABLE fixture_assignments (assignment_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL, binding JSONB NOT NULL, live BOOLEAN NOT NULL DEFAULT TRUE,
    ctx_granted BOOLEAN NOT NULL DEFAULT TRUE, settlement_granted BOOLEAN NOT NULL DEFAULT TRUE,
    input_granted BOOLEAN NOT NULL DEFAULT TRUE, receipt_authenticated BOOLEAN NOT NULL DEFAULT TRUE)`,
  );
  const state = {
    time: start,
    executions: 0,
    projections: 0,
    persistenceOpens: 0,
    publications: [] as string[],
    observations: [] as number[],
    rollback: false,
    rejectOuter: false,
    rollbackSnapshot: undefined as
      | Awaited<ReturnType<typeof snapshot>>
      | undefined,
    lostCompletion: false,
    lostRenewal: false,
    commitKind: "",
    gateKind: "",
  };
  const gate = { reached: deferred(), release: deferred() };
  const observed = deferred();
  const session: SqlSession = {
    query: db.query,
    async transaction(callback) {
      return await db.transaction(async (tx) => {
        const result = await callback({
          async query(sql, params) {
            if (state.rollback && sql === "RELEASE SAVEPOINT owner_command_0") {
              state.rollback = false;
              state.rollbackSnapshot = await snapshot(tx);
              throw new Error("injected command rollback");
            }
            return tx.query(sql, params);
          },
        });
        if (state.rejectOuter) {
          state.rejectOuter = false;
          throw new Error("injected outer rollback");
        }
        if (state.gateKind && state.commitKind === state.gateKind) {
          state.gateKind = "";
          gate.reached.resolve();
          await gate.release.promise;
        }
        return result;
      });
    },
  };
  const notes = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
      },
    } as const,
  });
  const action = input.action ??
    defineAction({
      id: "fixture.work",
      inputSchema: { type: "string" } as const,
      outputSchema: {
        type: "object",
        properties: { id: { type: "string" }, message: { type: "string" } },
        required: ["id", "message"],
      } as const,
      async execute(value: string, ctx: ActionContext) {
        state.executions++;
        const ref = await ctx.transaction(
          async ({ collections }) =>
            await collections.notes.create({ id: "note", title: value }),
          { operationKey: "write" },
        );
        const greet = ctx.resources.fixture.greet as (value: unknown) => string;
        const finish = ctx.adapters.fixture.finish as (value: string) => string;
        await input.afterAction?.(ctx);
        return { id: ref.id, message: finish(greet(value)) };
      },
    });
  const processor = defineProcessor({
    id: "fixture.observe",
    on: [{ eventType: "note.created" }],
    async handle() {
      state.observations.push(
        (await db.query("SELECT id FROM nodes")).rows.length,
      );
      observed.resolve();
    },
  });
  const registry = createPluginRegistry({
    plugins: [
      definePlugin({
        id: "fixture",
        version: "1",
        actions: { work: action },
        collections: { notes },
        processors: { observe: processor },
        resources: {
          fixture: { greet: (value: unknown) => `hello ${value}` },
          persistence: {
            open() {
              state.persistenceOpens++;
              throw new Error("worker persistence forbidden");
            },
          },
        },
        adapters: { fixture: { finish: (value: string) => `${value}!` } },
        views: {
          view: defineView({
            id: "fixture.view",
            shows: { list: "note" },
            renderer: "text",
            modes: ["context"],
            render: () => "owner-only",
          }),
        },
      }),
    ],
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({
    session: db,
    now: () => new Date(state.time),
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "processor-fixture",
  });
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    session: {
      query() {
        throw new Error("ambient execution query forbidden");
      },
      transaction() {
        throw new Error("ambient execution transaction forbidden");
      },
    },
    schema: "public",
    registry,
    catalog,
    executor,
    leaseMs: 1000,
    allowRecovery: input.allowRecovery,
    scheduleSettlement: input.scheduleSettlement,
    publish: (event) => {
      state.publications.push(event.type);
    },
    async resolveAssignment(tx, caller) {
      await input.validateCaller?.(tx, caller);
      const row = (await tx.query<
        {
          binding: OwnerExecutionAssignment;
          ctx_granted: boolean;
          settlement_granted: boolean;
        }
      >(
        "SELECT binding,ctx_granted,settlement_granted FROM fixture_assignments WHERE assignment_id=$1 AND session_id=$2 AND worker_id=$3 AND live=TRUE",
        [caller.assignmentId, caller.sessionId, caller.workerId],
      )).rows[0];
      return row
        ? {
          ...row.binding,
          ctxGranted: row.ctx_granted,
          settlementGranted: row.settlement_granted,
        }
        : undefined;
    },
    async authorizeInput(tx, assignment, value, time) {
      state.projections++;
      const row = (await tx.query(
        "SELECT input_granted FROM fixture_assignments WHERE assignment_id=$1 AND session_id=$2 AND live=TRUE",
        [assignment.assignmentId, assignment.sessionId],
      )).rows[0];
      if (row?.input_granted !== true) {
        throw new Error("input authorization revoked");
      }
      await input.inputPolicy?.(tx, assignment, value, time);
    },
  });
  const effects = createOwnerEffectCommands({
    ownerId: "owner",
    schema: "public",
    async authorizeEffect(tx, caller, ref, mode, time) {
      const a = mode === "begin"
        ? await execution.authorizeLive(tx, caller, time)
        : await execution.authorizeSettlement(tx, caller, time);
      return ref.namespace === a.namespace &&
        ref.actionRunId === a.invocation.actionRunId;
    },
    validateOutcome: () => true,
    verifyNotStarted: (_tx, _caller, _ref, evidence) =>
      evidence.source === "fixture" &&
      evidence.reference === "verified-no-start",
  });
  const collection = createOwnerCollectionCommand({
    session,
    schema: "public",
    registry,
    collections: registry.collections,
    executor,
    scope: (ctx) => ({
      namespace: "space",
      identity: {
        causationId: String(ctx.caller.sourceEventId),
        settlementScopeId: String(ctx.caller.sourceEventId),
      },
    }),
  });
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => input.now?.() ?? state.time,
    handlers: {
      ...execution.handlers,
      ...effects.handlers,
      collections: collection,
    },
    projections: { ...execution.projections, ...effects.projections },
    async authorize(tx, caller, command, time) {
      state.commitKind = command.kind;
      if (command.kind === "collections") {
        const assignment = await execution.authorizeLive(tx, caller, time);
        assert.equal(command.domain, "logical");
        assert.ok(
          command.key.startsWith(`${assignment.invocation.operationKey}/`),
          "Collection key is invocation-bound",
        );
      } else if (command.kind.startsWith("effect.")) {
        await effects.authorize(tx, caller, command, time);
      } else await execution.authorize(tx, caller, command, time);
    },
    async authenticateReceipt(tx, caller) {
      const found = await tx.query(
        "SELECT 1 FROM fixture_assignments WHERE worker_id=$1 AND receipt_authenticated=TRUE",
        [caller.workerId],
      );
      if (!found.rows.length) throw new Error("receipt authentication refused");
    },
  });
  await boundary.acquire(0);
  const source = await db.transaction((tx) =>
    createEventStore({
      session: db,
      ownerCommit: {
        transaction: tx,
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        commandTime: start,
      },
      admitOperationEventSql: (value, param) =>
        catalog.admitEventSql(value, param),
      indexOperationEventSql: (value, param) =>
        catalog.indexEventSql(value, param),
      indexOperationEvent: (transaction, value) =>
        catalog.indexEvent(transaction, value),
    }).commitMutation({
      transaction: tx,
      draft: {
        type: "registered.action.input",
        namespace: "space",
        payload: input.inline ? "world" : {
          dataRef: {
            eventBodyId: "source-input",
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        deduplicationId: "source",
      },
      ...(input.inline ? {} : {
        body: {
          id: "source-input",
          json: input.sourceInput === undefined ? "world" : input.sourceInput,
        },
      }),
      consumers: [{
        consumerId: "registered:fixture.work",
        settlement: "inherit",
      }],
      maxAttempts: 4,
    })
  );
  let binding: OwnerExecutionAssignment = {
    ownerId: "owner",
    workerId: "worker",
    assignmentId: "assignment",
    sessionId: "session",
    namespace: "space",
    actionId: action.id,
    deliveryId: source.deliveries[0].id,
    dispatchAttemptId: "attempt-1",
    ctxGranted: true,
    settlementGranted: true,
    invocation: {
      actionRunId: "run",
      rootKey: "root",
      operationKey: "root/work",
      metadata: { origin: "trusted" },
      identity: {
        causationId: source.event.id,
        settlementScopeId: source.event.id,
      },
    },
  };
  await db.query(
    "INSERT INTO fixture_assignments(assignment_id,session_id,worker_id,binding) VALUES($1,$2,$3,$4::jsonb)",
    [
      binding.assignmentId,
      binding.sessionId,
      binding.workerId,
      JSON.stringify(binding),
    ],
  );
  const caller = (): OwnerCaller => ({
    workerId: binding.workerId,
    ownerEpoch: 1,
    assignmentId: binding.assignmentId,
    sessionId: binding.sessionId,
    dispatchAttemptId: binding.dispatchAttemptId,
    sourceEventId: source.event.id,
  });
  const effectPort = (authenticated = caller()) => ({
    execute: (command: OwnerCommand, options = {}) =>
      boundary.execute(authenticated, command, options),
    settle: (command: OwnerCommand, options = {}) =>
      boundary.execute(authenticated, command, options),
    project: (
      kind: string,
      value: import("./boundary.ts").OwnerJson,
      options = {},
    ) => boundary.project(authenticated, kind, value, options),
  });
  const createPort = (authenticated = caller()) => ({
    effects: effectPort(authenticated),
    ...createRegisteredOwnerExecutionPort({
      ownerId: "owner",
      namespace: "space",
      port: {
        async execute(command, options) {
          const value = await boundary.execute(authenticated, command, options);
          if (command.kind === "execution.renew" && state.lostRenewal) {
            state.lostRenewal = false;
            throw Object.assign(new Error("lost committed renewal reply"), {
              outcome: "unknown",
            });
          }
          return value;
        },
        async complete(command, options) {
          const value = await boundary.execute(authenticated, command, options);
          if (state.lostCompletion) {
            state.lostCompletion = false;
            throw Object.assign(new Error("lost committed completion reply"), {
              outcome: "unknown",
            });
          }
          return value;
        },
        project: (kind, value, options) =>
          boundary.project(authenticated, kind, value, options),
        readReceipt: (identity) =>
          boundary.readReceipt(authenticated, identity),
      },
    }),
  });
  const ports = new Map<string, ReturnType<typeof createPort>>();
  const port = (authenticated = caller()) => {
    const key = JSON.stringify(authenticated);
    let value = ports.get(key);
    if (!value) {
      value = createPort(structuredClone(authenticated));
      ports.set(key, value);
    }
    return value;
  };
  const worker = (authenticated = caller()) =>
    createRegisteredActionWorker({
      registry,
      owner: createPort(structuredClone(authenticated)),
      createCapabilities: () => ({
        resources: { fixture: registry.resources.fixture },
        adapters: registry.adapters,
      }),
    });
  const hint = () => ({
    assignmentId: binding.assignmentId,
    sessionId: binding.sessionId,
  });
  const claimCommand = (): OwnerCommand => ({
    kind: "execution.claim",
    domain: "incarnation",
    key: ownerClaimKey("owner", binding.assignmentId, binding.sessionId),
    intent: hint(),
  });
  const completeCommand = (
    completion: RegisteredExecutionCompletion,
  ): OwnerCommand => ({
    kind: "execution.complete",
    domain: "logical",
    key: ownerCompletionKey("owner", "space", "run"),
    intent: { namespace: "space", executionId: "run", completion },
  });
  return {
    db,
    state,
    gate,
    registry,
    boundary,
    store,
    source,
    observed,
    caller,
    port,
    freshPort: createPort,
    effects: (authenticated = caller()) =>
      createOwnerEffectClient({
        ownerId: "owner",
        namespace: "space",
        actionRunId: "run",
        port: effectPort(authenticated),
      }),
    worker,
    hint,
    claimCommand,
    completeCommand,
    reference: () => ({
      executionId: "run",
      deliveryId: binding.deliveryId,
      dispatchAttemptId: binding.dispatchAttemptId,
    }),
    set: (
      column:
        | "ctx_granted"
        | "settlement_granted"
        | "input_granted"
        | "live"
        | "receipt_authenticated",
      value: boolean,
    ) => db.query(`UPDATE fixture_assignments SET ${column}=$1`, [value]),
    async replace(overrides: Partial<OwnerExecutionAssignment> = {}) {
      binding = {
        ...binding,
        dispatchAttemptId: "attempt-2",
        assignmentId: "assignment-2",
        sessionId: "session-2",
        ...overrides,
      };
      await db.query("DELETE FROM fixture_assignments");
      await db.query(
        "INSERT INTO fixture_assignments(assignment_id,session_id,worker_id,binding) VALUES($1,$2,$3,$4::jsonb)",
        [
          binding.assignmentId,
          binding.sessionId,
          binding.workerId,
          JSON.stringify(binding),
        ],
      );
    },
    async close() {
      gate.release.resolve();
      boundary.stop();
      await executor.shutdown();
      await db.close();
    },
  };
}
