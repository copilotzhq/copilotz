import assert from "node:assert/strict";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import {
  createRegisteredProcessorOwnerPort,
  createRegisteredProcessorWorker,
  ownerProcessorClaimKey,
  ownerProcessorOperationKey,
  type RegisteredProcessorOwnerPort,
} from "../execution/registered-processor.ts";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineView } from "../views/definition.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerJson,
} from "./boundary.ts";
import { createOwnerCollectionCommand } from "./collections.ts";
import {
  createOwnerProcessorCommands,
  type OwnerProcessorAssignment,
} from "./processor.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

export const processorStart = "2020-01-01T00:00:00.000Z";
export async function processorFixture(input: {
  processor?: Processor;
  data?: OwnerJson;
  detached?: boolean;
  observeWrites?: boolean;
  contentCollection?: boolean;
  maxAttempts?: number;
  leaseMs?: number;
  now?(): string;
  afterWrite?(context: ProcessorContext): void | Promise<void>;
  invokeAction?: RegisteredProcessorOwnerPort["invokeAction"];
} = {}) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const state = {
    time: processorStart,
    live: true,
    ctx: true,
    settlement: true,
    event: true,
    receipt: true,
    executions: 0,
    projections: 0,
    persistenceOpens: 0,
    rollback: false,
    unknownComplete: false,
    unknownClaim: false,
    unknownRenewal: false,
    renewals: 0,
    schedules: [] as string[],
    retryWakes: [] as string[],
    published: [] as string[],
  };
  const session: SqlSession = {
    query: db.query,
    transaction: (run) =>
      db.transaction(async (tx) => {
        const value = await run(tx);
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected outer rollback");
        }
        return value;
      }),
  };
  const notes = defineCollection({
    name: "note",
    ...(input.contentCollection ? { content: { fields: ["title"] } } : {}),
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
      },
    } as const,
  });
  const processor = input.processor ?? defineProcessor({
    id: "fixture.observe",
    on: [{ eventType: "fixture.source" }],
    async handle(event, ctx) {
      state.executions++;
      await ctx.transaction(({ collections }) =>
        collections.notes.create({
          id: "note",
          title: (event.data as { title: string }).title,
        }), { operationKey: "write" });
      await input.afterWrite?.(ctx);
    },
  });
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "fixture",
      version: "1",
      collections: { notes },
      processors: {
        observe: processor,
        ...(input.observeWrites
          ? {
            afterWrite: defineProcessor({
              id: "fixture.afterWrite",
              on: [{ eventType: "note.created" }],
              handle() {
                throw new Error("Must remain queued");
              },
            }),
          }
          : {}),
      },
      actions: {
        echo: defineAction({
          id: "fixture.echo",
          execute: (value: unknown) => value,
        }),
      },
      resources: {
        fixture: { label: "owner-backed" },
        persistence: {
          open() {
            state.persistenceOpens++;
            throw new Error("worker persistence forbidden");
          },
        },
      },
      adapters: { fixture: { label: "adapter" } },
      views: {
        note: defineView({
          id: "fixture.note",
          shows: "note",
          renderer: "text",
          modes: ["context"],
          render: () => "note",
        }),
      },
    })],
  });
  const catalog = createOperationCatalog(db, "public");
  let assignment: OwnerProcessorAssignment;
  const processorCommands = createOwnerProcessorCommands({
    ownerId: "owner",
    schema: "public",
    session,
    registry,
    catalog,
    leaseMs: input.leaseMs ?? 1000,
    resolveAssignment(_tx, caller) {
      return state.live && assignment &&
          caller.assignmentId === assignment.assignmentId &&
          caller.sessionId === assignment.sessionId &&
          (caller.principal.kind === "worker"
              ? caller.principal.workerId
              : undefined) === assignment.workerId
        ? {
          ...assignment,
          ctxGranted: state.ctx,
          settlementGranted: state.settlement,
        }
        : undefined;
    },
    authorizeEvent() {
      state.projections++;
      if (!state.event) throw new Error("event authority revoked");
    },
    scheduleSettlement(context, scope) {
      context.afterCommit(() => {
        state.schedules.push(scope.operationId);
      });
    },
    scheduleRetry(context, delivery) {
      context.afterCommit(() => {
        state.retryWakes.push(delivery.availableAt);
      });
    },
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "processor-test",
    workloads: {},
    scheduleDelivery() {
      if (!input.observeWrites) throw new Error("Unexpected child delivery");
    },
    dispatchWork: () => Promise.reject(new Error("No worker-local dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("No legacy executor")),
    dispatchRecoverable: () => Promise.reject(new Error("No legacy recovery")),
    settleOutputs: () => Promise.reject(new Error("No output capability")),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const collections = createOwnerCollectionCommand({
    session,
    schema: "public",
    registry,
    collections: registry.collections,
    executor,
    async scope(context) {
      const live = await processorCommands.authorizeLive(
        context.tx,
        context.caller,
        context.commandTime,
      );
      return {
        namespace: live.assignment.namespace,
        identity: {
          causationId: live.event.id,
          correlationId: live.event.correlationId,
          settlementScopeId: live.delivery.settlementScopeId,
          ...(live.delivery.actionScopeId
            ? { actionScopeId: live.delivery.actionScopeId }
            : {}),
          deliveryLease: {
            deliveryId: live.delivery.id,
            owner: live.assignment.dispatchAttemptId,
          },
          metadata: {
            sourceEventId: live.event.id,
            sourceDeliveryId: live.delivery.id,
            sourceConsumerId: live.delivery.consumerId,
          },
        },
      };
    },
    publish: (event) => {
      state.published.push(event.type);
    },
  });
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => input.now?.() ?? state.time,
    handlers: {
      ...processorCommands.handlers,
      collections,
      async seed(_intent, context) {
        const store = createEventStore({
          session,
          ownerCommit: {
            ...context.ownerCommit,
            afterCommit: context.afterCommit,
          },
          admitOperationEventSql: (value, param) =>
            catalog.admitEventSql(value, param),
          indexOperationEventSql: (value, param) =>
            catalog.indexEventSql(value, param),
          indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
        });
        const result = await store.commitMutation({
          transaction: context.tx,
          draft: {
            type: "fixture.source",
            namespace: "space",
            payload: {
              dataRef: {
                eventBodyId: "processor-source",
                schemaVersion: 1,
                mediaType: "application/json",
              },
            },
            deduplicationId: "source",
          },
          body: {
            id: "processor-source",
            json: input.data ?? { title: "hello" },
          },
          consumers: [{
            consumerId: `processor:${processor.id}`,
            settlement: input.detached ? "detached" : "inherit",
          }],
          maxAttempts: input.maxAttempts ?? 3,
        });
        return {
          eventId: result.event.id,
          deliveryId: result.deliveries[0].id,
        };
      },
    },
    projections: processorCommands.projections,
    async authorize(tx, caller, command, time) {
      if (command.kind === "seed") {
        if (caller.host !== true) throw new Error("host required");
        return;
      }
      if (command.kind === "collections") {
        const live = await processorCommands.authorizeLive(tx, caller, time);
        assert.equal(command.domain, "logical");
        assert.ok(
          command.key.startsWith(
            `${ownerProcessorOperationKey(live.delivery.id)}:`,
          ),
        );
      } else await processorCommands.authorize(tx, caller, command, time);
    },
    authenticateReceipt(_tx, caller) {
      if (
        !state.receipt ||
        (caller.principal.kind === "worker"
            ? caller.principal.workerId
            : undefined) !== "worker"
      ) {
        throw new Error("receipt refused");
      }
    },
  });
  await boundary.acquire(0);
  const seeded = await boundary.execute({
    principal: { kind: "worker" as const, workerId: "host" },
    ownerEpoch: 1,
    host: true,
  }, { kind: "seed", domain: "logical", key: "seed", intent: null });
  const source = seeded.result as { eventId: string; deliveryId: string };
  assignment = {
    kind: "processor",
    ownerId: "owner",
    workerId: "worker",
    assignmentId: "assignment",
    sessionId: "session",
    namespace: "space",
    processorId: processor.id,
    sourceEventId: source.eventId,
    deliveryId: source.deliveryId,
    dispatchAttemptId: "attempt-1",
    ctxGranted: true,
    settlementGranted: true,
  };
  const caller = (): OwnerCaller => ({
    principal: { kind: "worker" as const, workerId: assignment.workerId },
    ownerEpoch: 1,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    dispatchAttemptId: assignment.dispatchAttemptId,
  });
  const port = (who = caller()) =>
    createRegisteredProcessorOwnerPort({
      ownerId: "owner",
      invokeAction: input.invokeAction,
      port: {
        async execute(command, options) {
          const result = await boundary.execute(who, command, options);
          if (command.kind === "processor.renew") {
            state.renewals++;
            if (state.unknownRenewal) {
              state.unknownRenewal = false;
              throw Object.assign(new Error("lost renewal reply"), {
                outcome: "unknown",
              });
            }
          }
          if (command.kind === "processor.claim" && state.unknownClaim) {
            state.unknownClaim = false;
            throw Object.assign(new Error("lost claim reply"), {
              outcome: "unknown",
            });
          }
          return result;
        },
        async complete(command, options) {
          const result = await boundary.execute(who, command, options);
          if (state.unknownComplete) {
            state.unknownComplete = false;
            throw Object.assign(new Error("lost completion reply"), {
              outcome: "unknown",
            });
          }
          return result;
        },
        project: (kind, value, options) =>
          boundary.project(who, kind, value, options),
        readReceipt: (identity) => boundary.readReceipt(who, identity),
      },
    });
  const worker = () =>
    createRegisteredProcessorWorker({
      registry,
      owner: port(),
      createCapabilities: () => ({
        resources: { fixture: registry.resources.fixture },
        adapters: registry.adapters,
      }),
    });
  const hint = () => ({
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
  });
  return {
    db,
    state,
    source,
    registry,
    boundary,
    processorCommands,
    caller,
    port,
    worker,
    hint,
    store: createEventStore({ session: db }),
    reference: () => ({
      deliveryId: assignment.deliveryId,
      dispatchAttemptId: assignment.dispatchAttemptId,
    }),
    claimCommand: (): OwnerCommand => ({
      kind: "processor.claim",
      domain: "incarnation",
      key: ownerProcessorClaimKey(
        "owner",
        assignment.assignmentId,
        assignment.sessionId,
      ),
      intent: hint(),
    }),
    replace(overrides: Partial<OwnerProcessorAssignment> = {}) {
      assignment = {
        ...assignment,
        assignmentId: "assignment-2",
        sessionId: "session-2",
        dispatchAttemptId: "attempt-2",
        ...overrides,
      };
    },
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}
