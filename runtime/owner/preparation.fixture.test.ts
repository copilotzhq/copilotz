/** Actual current-table preparation capture, child admission and input gates.
 * Provider I/O, protected values and the production channel route are absent. */
import assert from "node:assert/strict";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { contentSequenceSchema } from "../content/schema.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { digestContent } from "../content/digest.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
import {
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  type OwnerChildActionReference,
} from "../execution/child-action-port.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineView } from "../views/definition.ts";
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
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerJson,
} from "./boundary.ts";
import { createOwnerChildActions } from "./child-action.ts";
import {
  createOwnerExecutionCommands,
  type OwnerWorkerExecutionAssignment,
} from "./execution.ts";
import {
  createOwnerPreparations,
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationKey,
  type OwnerPreparedInputContext,
} from "./preparation.ts";
import { createOwnerPreparationSource } from "./preparation-source.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerAssignmentControl,
  type OwnerActionAssignmentBinding,
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "./assignments.ts";

export const ownerId = "owner";
export const namespace = "space";
type PreparationFixtureOptions = {
  generic?: boolean;
  mapInput?(text: string): OwnerJson;
  executionGuard?: boolean;
  childGuard?: boolean;
  deferParentClaim?: boolean;
  transportAuthority?: {
    isCurrentStarted(caller: OwnerCaller): boolean;
    caller(assignment: OwnerWorkerExecutionAssignment): OwnerCaller;
    authenticateReceipt(caller: OwnerCaller): boolean;
  };
  now?(): string;
};
export async function fixture(options: PreparationFixtureOptions = {}) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    return await initializeFixture(db, options);
  } catch (error) {
    try {
      await db.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Preparation fixture setup and cleanup failed.",
      );
    }
    throw error;
  }
}
async function initializeFixture(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  options: PreparationFixtureOptions,
) {
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const state = {
    live: true,
    afterQuery: undefined as undefined | ((sql: string) => void),
    afterTransaction: undefined as undefined | (() => void),
    allowed: true,
    originalAllowed: true,
    resourceAllowed: true,
    audience: "channel",
    ctx: true,
    rendered: 0,
    projected: 0,
    resourceProjected: 0,
    mapped: 0,
    executed: 0,
    duringInputAuthorization: undefined as
      | undefined
      | ((assignment: OwnerWorkerExecutionAssignment) => void),
    rollBack: false,
    inTransaction: false,
    renderVersion: "original",
    duringResourceAuthorization: undefined as
      | undefined
      | ((purpose: string) => void | Promise<void>),
    revokeOnRead: undefined as string | undefined,
    duringRender: undefined as undefined | (() => void | Promise<void>),
    scheduled: [] as OwnerChildActionReference[],
    time: "2020-01-01T00:00:00.000Z",
  };
  const session: SqlSession = {
    query() {
      throw new Error("Ambient SQL forbidden");
    },
    async transaction(run) {
      state.inTransaction = true;
      try {
        const outcome = await db.transaction(async (tx) => {
          const result = await run({
            async query<
              TRow extends Record<string, unknown> = Record<string, unknown>,
            >(sql: string, params?: unknown[]) {
              if (state.revokeOnRead && params?.includes(state.revokeOnRead)) {
                state.originalAllowed = false;
                state.revokeOnRead = undefined;
              }
              const result = await tx.query<TRow>(sql, params);
              state.afterQuery?.(sql);
              return result;
            },
          });
          if (state.rollBack) {
            state.rollBack = false;
            throw new Error("outer rollback");
          }
          return result;
        });
        state.afterTransaction?.();
        return outcome;
      } finally {
        state.inTransaction = false;
      }
    },
  };
  const style = { prefix: "Reply:", hidden: "private" };
  const registry = createPluginRegistry({
    actions: {
      parent: defineAction({ id: "fixture.parent", execute: () => null }),
      child: defineAction({
        id: "fixture.child",
        execute(input: unknown) {
          state.executed++;
          return input;
        },
      }),
    },
    resources: { channel: { style } },
    views: options.generic ? {} : {
      message: defineView({
        id: "fixture.message.channel",
        shows: "message",
        renderer: "text",
        modes: ["channel", "brief"],
        async render(
          value: { record: { title: string }; content: { value: string }[] },
          context,
        ) {
          state.rendered++;
          await state.duringRender?.();
          return `${
            (context.resources.channel.style as { prefix: string }).prefix
          } ${value.record.title} ${
            value.content[0].value
          } ${state.renderVersion}`;
        },
      }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({ session: db });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "unused",
  });
  const controlCaller: OwnerCaller = {
    principal: { kind: "owner-control", ownerId, epoch: 1, holderId: "holder" },
    ownerEpoch: 1,
  };
  if (options.transportAuthority) await provisionOwnerAssignments(db, "public");
  const assignmentControl = options.transportAuthority
    ? createOwnerAssignmentControl({
      ownerId,
      schema: "public",
      authorizeControl(_tx, caller) {
        assert.deepEqual(caller, controlCaller);
      },
      isCurrentStarted: options.transportAuthority.isCurrentStarted,
    })
    : undefined;
  const assignments = new Map<string, OwnerWorkerExecutionAssignment>();
  const guard = (tx: SqlExecutor, context: OwnerPreparedInputContext) =>
    preparations.authorizeCaptured(tx, context);
  const makeExecution = (guarded: boolean) =>
    createOwnerExecutionCommands({
      ownerId,
      schema: "public",
      session,
      registry,
      catalog,
      executor,
      async resolveAssignment(tx, caller) {
        const a = assignments.get(String(caller.assignmentId));
        if (assignmentControl) {
          const binding = await assignmentControl.resolveStarted(tx, caller);
          if (
            !binding || !a || binding.deliveryId !== a.deliveryId ||
            binding.dispatchAttemptId !== a.dispatchAttemptId ||
            binding.sessionId !== a.sessionId
          ) return undefined;
        }
        return a ? { ...a, ctxGranted: state.ctx } : undefined;
      },
      authorizeInput(_tx, assignment) {
        if (assignment.placement !== "worker") {
          throw new Error("fixture requires worker placement");
        }
        state.duringInputAuthorization?.(assignment);
      },
      allowRecovery: () => true,
      ...(guarded ? { authorizePreparedInput: guard } : {}),
    });
  const execution = makeExecution(options.executionGuard !== false);
  const makeChild = (guarded: boolean) =>
    createOwnerChildActions({
      ownerId,
      schema: "public",
      session,
      registry,
      catalog,
      isCurrentParent(who, binding) {
        const a = assignments.get(String(who.assignmentId));
        return state.live && state.ctx && !!a && binding.kind === "action" &&
          who.principal.kind === "worker" &&
          who.principal.workerId === a.workerId &&
          who.sessionId === a.sessionId &&
          who.dispatchAttemptId === a.dispatchAttemptId &&
          binding.assignment.deliveryId === a.deliveryId &&
          (!options.transportAuthority ||
            options.transportAuthority.isCurrentStarted(who) === true);
      },
      async resolveParent(tx, caller, time) {
        const assignment = await execution.authorizeLive(tx, caller, time);
        if (assignment.placement !== "worker") {
          throw new Error("fixture requires worker placement");
        }
        return {
          kind: "action",
          assignment,
        };
      },
      authorizeChild() {
        if (!state.allowed) throw new Error("current child denied");
      },
      ...(guarded ? { authorizePreparedInput: guard } : {}),
      schedule(ref) {
        assert.equal(state.inTransaction, false);
        state.scheduled.push(ref);
      },
    });
  const child = makeChild(options.childGuard !== false);
  const source = createOwnerPreparationSource({
    ownerId,
    schema: "public",
    sources: {
      messages: {
        collection: defineCollection({
          name: "message",
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              namespace: { type: "string" },
              title: { type: "string" },
              content: contentSequenceSchema,
            },
            required: ["id", "namespace", "content"],
          } as const,
          content: { fields: ["content"] },
        }),
        contentPath: "content",
      },
    },
    authorize() {
      if (!state.allowed) throw new Error("current source denied");
      return { namespace, audience: state.audience };
    },
    authorizeReference() {
      if (!state.originalAllowed) throw new Error("original source denied");
      return true;
    },
    projectRecord(record) {
      state.projected++;
      return { title: record.title };
    },
  });
  const preparations = createOwnerPreparations({
    ownerId,
    schema: "public",
    registry,
    children: child,
    source,
    preparations: {
      "channel.text": {
        source: "messages",
        actionAlias: "child",
        shows: "message",
        modes: ["channel", "brief"],
        resources: [{ namespace: "channel", alias: "style" }],
        mapInput(text) {
          state.mapped++;
          return options.mapInput ? options.mapInput(text) : { text };
        },
      },
    },
    projectResource(_tx, { value }) {
      state.resourceProjected++;
      return { prefix: (value as { prefix: string }).prefix };
    },
    async authorizeResource(_tx, context): Promise<true> {
      if (!state.resourceAllowed) throw new Error("original resource denied");
      await state.duringResourceAuthorization?.(context.purpose);
      return true;
    },
  });
  const root = createOwnerActionAdmission({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    schedule() {},
  });
  const boundary = createOwnerCommandBoundary({
    currentAuthorizationKinds: [
      OWNER_CHILD_ACTION_ADMISSION,
      OWNER_CHILD_ACTION_RESULT,
      OWNER_CHILD_ACTION_PREPARATION,
    ],
    isCurrentAuthorization: (tx, who, command, time) =>
      [
          OWNER_CHILD_ACTION_ADMISSION,
          OWNER_CHILD_ACTION_RESULT,
          OWNER_CHILD_ACTION_PREPARATION,
        ].includes(
          command.kind,
        )
        ? child.isCurrentAuthorization(tx, who, command, time)
        : true,
    ownerId,
    holderId: "holder",
    schema: "public",
    session,
    now: () => options.now?.() ?? state.time,
    inputDefinitions: {
      ...execution.inputDefinitions,
      [OWNER_ACTION_ADMISSION]: root.inputDefinition,
      [OWNER_CHILD_ACTION_ADMISSION]: child.inputDefinition,
      [OWNER_CHILD_ACTION_PREPARATION]: preparations.inputDefinition,
    },
    handlers: {
      ...assignmentControl?.handlers,
      ...execution.handlers,
      [OWNER_ACTION_ADMISSION]: root.handler,
      [OWNER_CHILD_ACTION_ADMISSION]: child.handler,
      [OWNER_CHILD_ACTION_PREPARATION]: preparations.handler,
    },
    projections: {
      ...execution.projections,
      [OWNER_CHILD_ACTION_RESULT]: child.projection,
    },
    async authorize(tx, caller, command, time, input) {
      if (assignmentControl && command.kind.startsWith("assignment.")) {
        return await assignmentControl.authorize(tx, caller, command, time);
      }
      if (command.kind === OWNER_ACTION_ADMISSION) {
        validateOwnerActionAdmissionIdentity(ownerId, command, input);
        return;
      }
      if (
        command.kind === OWNER_CHILD_ACTION_PREPARATION
      ) {
        return await preparations.authorize(tx, caller, command, time, input);
      }
      if (
        [OWNER_CHILD_ACTION_ADMISSION, OWNER_CHILD_ACTION_RESULT].includes(
          command.kind,
        )
      ) {
        return await child.authorize(tx, caller, command, time, input);
      }
      return await execution.authorize(tx, caller, command, time, input);
    },
    authenticateReceipt(_tx, caller) {
      if (options.transportAuthority?.authenticateReceipt(caller) !== true) {
        throw new Error("No receipt hydration");
      }
    },
  });
  await boundary.acquire(0);
  const rootRef = (await boundary.executeInput({
    principal: { kind: "worker", workerId: "ingress" },
    ownerEpoch: 1,
  }, {
    kind: OWNER_ACTION_ADMISSION,
    domain: "logical",
    key: ownerActionAdmissionKey(ownerId, namespace, "root"),
    input: {
      namespace,
      actionAlias: "parent",
      requestId: "root",
      input: {},
      metadata: {},
      provenance: {},
    },
  })).result as OwnerChildActionReference;
  function assign(
    ref: OwnerChildActionReference,
    id: string,
    binding?: { workerId: string; sessionId: string },
  ): OwnerWorkerExecutionAssignment {
    const a: OwnerWorkerExecutionAssignment = {
      placement: "worker",
      ownerId,
      workerId: binding?.workerId ?? `worker:${id}`,
      assignmentId: id,
      sessionId: binding?.sessionId ?? `session:${id}`,
      namespace,
      actionId: ref.actionId,
      deliveryId: ref.deliveryId,
      dispatchAttemptId: `attempt:${id}`,
      ctxGranted: true,
      settlementGranted: true,
      invocation: {
        actionRunId: ref.executionId,
        operationKey: ref.executionId,
        rootKey: rootRef.executionId,
        metadata: {},
        ...(ref === rootRef ? {} : { parentActionRunId: rootRef.executionId }),
        identity: {
          causationId: ref.eventId,
          settlementScopeId: rootRef.eventId,
        },
      },
    };
    assignments.set(id, a);
    return a;
  }
  let parent = assign(rootRef, "parent");
  function bindParent(
    id: string,
    binding: { workerId: string; sessionId: string },
  ) {
    if (!options.deferParentClaim) {
      throw new Error("Parent was already claimed");
    }
    assignments.delete(parent.assignmentId);
    parent = assign(rootRef, id, binding);
    return parent;
  }
  const caller = (a = parent): OwnerCaller =>
    options.transportAuthority?.caller(a) ?? ({
      principal: { kind: "worker", workerId: a.workerId },
      ownerEpoch: 1,
      assignmentId: a.assignmentId,
      sessionId: a.sessionId,
      dispatchAttemptId: a.dispatchAttemptId,
    });
  const claim = (a: OwnerWorkerExecutionAssignment) =>
    boundary.execute(caller(a), {
      kind: "execution.claim",
      domain: "incarnation",
      key: ownerClaimKey(ownerId, a.assignmentId, a.sessionId),
      intent: { assignmentId: a.assignmentId, sessionId: a.sessionId },
    });
  if (!options.deferParentClaim) await claim(parent);
  const parentRef = () => ({
    deliveryId: parent.deliveryId,
    dispatchAttemptId: parent.dispatchAttemptId,
    operationKey: parent.invocation.operationKey,
  });
  const request = (operationKey = "send", mode = "channel") => ({
    kind: OWNER_CHILD_ACTION_PREPARATION,
    domain: "logical" as const,
    key: ownerPreparationKey(
      ownerId,
      namespace,
      parent.invocation.operationKey,
      "channel.text",
      operationKey,
    ),
    input: {
      parent: parentRef(),
      preparation: "channel.text",
      targetActionId: "fixture.child",
      operationKey,
      recordId: "message-1",
      hints: { mode, renderer: "text" },
    },
  });
  const prepare = (operationKey = "send", mode = "channel") =>
    boundary.executeInput(caller(), request(operationKey, mode));
  const bodyStore = createDatabaseBodyStore({ session: db, schema: "public" });
  await db.query(
    "INSERT INTO nodes(id,namespace,type,name,data) VALUES('message-1','space','message','message-1',$1)",
    [{ title: "Title", content: [] }],
  );
  async function addAsset(id: string, value: string) {
    const bytes = new TextEncoder().encode(value);
    const digest = await digestContent(bytes);
    const bodyId = `body:${id}`;
    await bodyStore.put({ bodyId, bytes, digest, mediaType: "text/plain" });
    await db.query(
      "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,'space','asset',$1,$2)",
      [id, {
        state: "ready",
        bodyId,
        location: { kind: "database", key: bodyId },
        byteLength: bytes.length,
        digest,
        mediaType: "text/plain",
      }],
    );
    await db.query(
      "INSERT INTO edges(id,namespace,source_node_id,target_node_id,type) VALUES($1,'space','message-1',$2,'has_asset')",
      [`edge:${id}`, id],
    );
    return { assetId: id, kind: "text", role: "body", mediaType: "text/plain" };
  }
  const ref = await addAsset("asset-1", "body");
  await db.query(
    "UPDATE nodes SET data=jsonb_set(data,'{content}',$1::jsonb) WHERE id='message-1'",
    [JSON.stringify([ref])],
  );
  const input = async (ref: OwnerChildActionReference) => {
    const event = await store.getEvent(ref.eventId);
    return await readEventBody(
      { transaction: db, tables: createCoreTableNames("public") },
      namespace,
      eventDataRef(event!.payload),
    );
  };
  const project = (ref: OwnerChildActionReference) =>
    boundary.project(caller(), OWNER_CHILD_ACTION_RESULT, {
      parent: parentRef(),
      reference: ref,
    });
  const complete = (
    a: OwnerWorkerExecutionAssignment,
    completion: OwnerJson = { status: "completed", output: { ok: true } },
  ) =>
    boundary.executeInput(caller(a), {
      kind: "execution.complete",
      domain: "logical",
      key: ownerCompletionKey(ownerId, namespace, a.invocation.actionRunId),
      input: { namespace, executionId: a.invocation.actionRunId, completion },
    });
  return {
    db,
    state,
    registry,
    style,
    boundary,
    execution,
    child,
    preparations,
    makeExecution,
    makeChild,
    store,
    rootRef,
    get parent() {
      return parent;
    },
    bindParent,
    async bindTransport(binding: OwnerActionAssignmentBinding) {
      if (!assignmentControl) {
        throw new Error("Transport authority unavailable");
      }
      return await boundary.execute(controlCaller, {
        kind: "assignment.bind",
        domain: "incarnation",
        key: `${ownerAssignmentKey(ownerId, binding)}:assignment.bind`,
        intent: binding,
      });
    },
    caller,
    claim,
    assign,
    parentRef,
    prepare,
    request,
    input,
    project,
    complete,
    addAsset,
    close: async () => {
      boundary.stop();
      await db.close();
    },
  };
}
