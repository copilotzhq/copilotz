/** Actual current-table preparation capture, child admission and input gates.
 * Provider I/O, protected values and the production channel route are absent. */
import assert from "node:assert/strict";
import { test } from "node:test";
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
  ownerChildActionKey,
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
  type OwnerExecutionAssignment,
} from "./execution.ts";
import {
  createOwnerPreparations,
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationKey,
  type OwnerPreparedInputContext,
} from "./preparation.ts";
import { createOwnerPreparationSource } from "./preparation-source.ts";
import { preparationCaptureFromMetadata } from "./preparation-capture.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const ownerId = "owner";
const namespace = "space";
async function fixture(
  options: {
    generic?: boolean;
    executionGuard?: boolean;
    childGuard?: boolean;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const state = {
    allowed: true,
    originalAllowed: true,
    resourceAllowed: true,
    audience: "channel",
    ctx: true,
    rendered: 0,
    projected: 0,
    resourceProjected: 0,
    mapped: 0,
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
        return await db.transaction(async (tx) => {
          const result = await run({
            query(sql, params) {
              if (state.revokeOnRead && params?.includes(state.revokeOnRead)) {
                state.originalAllowed = false;
                state.revokeOnRead = undefined;
              }
              return tx.query(sql, params);
            },
          });
          if (state.rollBack) {
            state.rollBack = false;
            throw new Error("outer rollback");
          }
          return result;
        });
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
        execute: (input: unknown) => input,
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
  const assignments = new Map<string, OwnerExecutionAssignment>();
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
      leaseMs: 60_000,
      resolveAssignment(_tx, caller) {
        const a = assignments.get(String(caller.assignmentId));
        return a ? { ...a, ctxGranted: state.ctx } : undefined;
      },
      authorizeInput() {},
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
      async resolveParent(tx, caller, time) {
        return {
          kind: "action",
          assignment: await execution.authorizeLive(tx, caller, time),
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
          return { text };
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
    ownerId,
    holderId: "holder",
    schema: "public",
    session,
    now: () => state.time,
    inputDefinitions: {
      ...execution.inputDefinitions,
      [OWNER_ACTION_ADMISSION]: root.inputDefinition,
      [OWNER_CHILD_ACTION_ADMISSION]: child.inputDefinition,
      [OWNER_CHILD_ACTION_PREPARATION]: preparations.inputDefinition,
    },
    handlers: {
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
    authenticateReceipt() {
      throw new Error("No receipt hydration");
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
  ): OwnerExecutionAssignment {
    const a: OwnerExecutionAssignment = {
      ownerId,
      workerId: `worker:${id}`,
      assignmentId: id,
      sessionId: `session:${id}`,
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
  const parent = assign(rootRef, "parent");
  const caller = (a = parent): OwnerCaller => ({
    principal: { kind: "worker", workerId: a.workerId },
    ownerEpoch: 1,
    assignmentId: a.assignmentId,
    sessionId: a.sessionId,
    dispatchAttemptId: a.dispatchAttemptId,
  });
  const claim = (a: OwnerExecutionAssignment) =>
    boundary.execute(caller(a), {
      kind: "execution.claim",
      domain: "incarnation",
      key: ownerClaimKey(ownerId, a.assignmentId, a.sessionId),
      intent: { assignmentId: a.assignmentId, sessionId: a.sessionId },
    });
  await claim(parent);
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
    [[ref]],
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
    a: OwnerExecutionAssignment,
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
    parent,
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

test("named preparation captures real View/content/resource once in the child lifecycle and reuses original facts", async () => {
  const f = await fixture();
  try {
    const first = await f.prepare();
    const ref = first.result as OwnerChildActionReference;
    assert.equal(first.status, "committed");
    assert.deepEqual(await f.input(ref), {
      text: "Reply: Title body original",
    });
    const source = await f.store.getEvent(ref.eventId);
    const capture = preparationCaptureFromMetadata(source!.metadata)!;
    assert.equal(capture.source.content[0].ref.assetId, "asset-1");
    assert.deepEqual(capture.view.selection, {
      kind: "registered",
      id: "fixture.message.channel",
    });
    assert.equal(JSON.stringify(capture).includes("Reply:"), false);
    const replacement = await f.addAsset("asset-2", "replacement");
    await f.db.query("UPDATE nodes SET data=$1 WHERE id='message-1'", [{
      title: "Changed",
      content: [replacement],
    }]);
    f.state.renderVersion = "changed";
    f.style.prefix = "Changed:";
    const counts = [
      f.state.rendered,
      f.state.projected,
      f.state.resourceProjected,
      f.state.mapped,
    ];
    assert.deepEqual(await f.prepare(), { status: "duplicate", result: ref });
    assert.deepEqual([
      f.state.rendered,
      f.state.projected,
      f.state.resourceProjected,
      f.state.mapped,
    ], counts);
    assert.deepEqual(await f.input(ref), {
      text: "Reply: Title body original",
    });
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE type='copilotz.owner.action.requested'",
      )).rows.length,
      2,
    );
    assert.equal(f.state.scheduled.length, 1);
    const child = f.assign(ref, "child");
    await f.claim(child);
    const projected = await f.boundary.project(
      f.caller(child),
      "execution.input",
      {
        executionId: ref.executionId,
        deliveryId: ref.deliveryId,
        dispatchAttemptId: child.dispatchAttemptId,
      },
    );
    assert.deepEqual((projected as { input: unknown }).input, {
      text: "Reply: Title body original",
    });
    await f.complete(child);
    assert.deepEqual(await f.project(ref), {
      status: "completed",
      output: { ok: true },
    });
    f.state.originalAllowed = false;
    await assert.rejects(f.project(ref), /original source denied/);
    assert.equal(f.state.rendered, 1);
  } finally {
    await f.close();
  }
});

test("named preparation preserves generic fallback and refuses changed semantic intent", async () => {
  const f = await fixture({ generic: true });
  try {
    const ref = (await f.prepare()).result as OwnerChildActionReference;
    const capture = preparationCaptureFromMetadata(
      (await f.store.getEvent(ref.eventId))!.metadata,
    )!;
    assert.deepEqual(capture.view.selection, { kind: "generic" });
    assert.equal(f.state.rendered, 0);
    assert.equal(
      JSON.parse((await f.input(ref) as { text: string }).text).record.title,
      "Title",
    );
    await assert.rejects(
      f.prepare("send", "brief"),
      /owner_intent_conflict|different intent/,
    );
    assert.equal(f.state.scheduled.length, 1);
  } finally {
    await f.close();
  }
});

test("prepared replay, child claim, live mutations and result reads require original permission", async () => {
  const f = await fixture();
  try {
    const ref = (await f.prepare()).result as OwnerChildActionReference;
    const child = f.assign(ref, "child");
    f.state.originalAllowed = false;
    await assert.rejects(f.prepare(), /original source denied/);
    await assert.rejects(f.claim(child), /original source denied/);
    assert.equal((await f.store.getDelivery(ref.deliveryId))!.attempts, 0);
    f.state.originalAllowed = true;
    await f.claim(child);
    f.state.originalAllowed = false;
    await assert.rejects(f.claim(child), /original source denied/);
    await assert.rejects(
      f.boundary.project(f.caller(child), "execution.input", {
        executionId: ref.executionId,
        deliveryId: ref.deliveryId,
        dispatchAttemptId: child.dispatchAttemptId,
      }),
      /original source denied/,
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        f.execution.authorizeLive(tx, f.caller(child), f.state.time)
      ),
      /original source denied/,
    );
    await assert.rejects(f.project(ref), /original source denied/);
    // Narrow safe failure settlement remains available after source/ctx revocation.
    f.state.ctx = false;
    await f.complete(child, { status: "failed", code: "action_failed" });
    assert.equal(
      (await f.store.getDelivery(ref.deliveryId))!.status,
      "dead_letter",
    );
    f.state.ctx = true;
    f.state.originalAllowed = true;
    f.state.resourceAllowed = false;
    await assert.rejects(f.prepare(), /original resource denied/);
    assert.equal(f.state.rendered, 1);
  } finally {
    await f.close();
  }
});

test("capture rechecks parent/source after rendering and rolls back body, event, delivery, receipt and publication", async () => {
  const f = await fixture();
  try {
    const counts = () =>
      Promise.all(
        ["events", "event_bodies", "event_deliveries", "owner_receipts"].map(
          async (table) =>
            Number(
              (await f.db.query<{ n: string }>(
                `SELECT COUNT(*) AS n FROM ${table}`,
              )).rows[0].n,
            ),
        ),
      );
    const before = await counts();
    f.state.duringRender = () => {
      f.state.originalAllowed = false;
    };
    await assert.rejects(f.prepare(), /original source denied/);
    assert.deepEqual(await counts(), before);
    assert.equal(f.state.scheduled.length, 0);
    f.state.originalAllowed = true;
    f.state.duringRender = undefined;
    f.state.rollBack = true;
    await assert.rejects(f.prepare(), /outer rollback|unknown/);
    assert.deepEqual(await counts(), before);
    assert.equal(f.state.scheduled.length, 0);
  } finally {
    await f.close();
  }
});

test("prepared child guards fail closed and ordinary admission cannot adopt prepared input", async () => {
  const missing = await fixture({ childGuard: false });
  try {
    await assert.rejects(missing.prepare(), /Prepared input authority/);
    assert.equal(missing.state.scheduled.length, 0);
  } finally {
    await missing.close();
  }
  const f = await fixture({ executionGuard: false });
  try {
    const ref = (await f.prepare()).result as OwnerChildActionReference;
    await assert.rejects(
      f.claim(f.assign(ref, "missing-guard")),
      /Prepared input authority/,
    );
    const local = 'prepare:["channel.text","send"]';
    await assert.rejects(
      f.boundary.executeInput(f.caller(), {
        kind: OWNER_CHILD_ACTION_ADMISSION,
        domain: "logical",
        key: ownerChildActionKey(
          ownerId,
          namespace,
          f.parent.invocation.operationKey,
          "fixture.child",
          local,
        ),
        input: {
          parent: f.parentRef(),
          actionAlias: "child",
          operationKey: local,
          input: await f.input(ref) as OwnerJson,
        },
      }),
      /Prepared input cannot be adopted/,
    );
  } finally {
    await f.close();
  }
});

test("capture refuses a parent revoked during View evaluation and a cancelled output gate", async () => {
  const f = await fixture();
  try {
    f.state.duringRender = () => {
      f.state.ctx = false;
    };
    await assert.rejects(f.prepare(), /authority was revoked/);
    assert.equal(f.state.scheduled.length, 0);
    f.state.ctx = true;
    const controller = new AbortController();
    f.state.duringRender = () => {
      controller.abort(new Error("caller cancelled"));
    };
    await assert.rejects(
      f.boundary.executeInput(f.caller(), f.request(), {
        signal: controller.signal,
      }),
      /caller cancelled/,
    );
    assert.equal(f.state.scheduled.length, 0);
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE type='copilotz.owner.action.requested'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a prepared admission cannot adopt an ordinary child capture under its derived run key", async () => {
  const f = await fixture();
  try {
    const local = 'prepare:["channel.text","send"]';
    const original = await f.boundary.executeInput(f.caller(), {
      kind: OWNER_CHILD_ACTION_ADMISSION,
      domain: "logical",
      key: ownerChildActionKey(
        ownerId,
        namespace,
        f.parent.invocation.operationKey,
        "fixture.child",
        local,
      ),
      input: {
        parent: f.parentRef(),
        actionAlias: "child",
        operationKey: local,
        input: { text: "ordinary first capture" },
      },
    });
    await assert.rejects(f.prepare(), /already belongs to another admission/);
    assert.deepEqual(
      await f.input(original.result as OwnerChildActionReference),
      { text: "ordinary first capture" },
    );
    assert.equal(f.state.scheduled.length, 1);
    assert.equal(
      (await f.db.query("SELECT key FROM owner_receipts WHERE kind=$1", [
        OWNER_CHILD_ACTION_PREPARATION,
      ])).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("missing prepared hooks refuse compatible claims, input, live mutation and completed result on an existing capture", async () => {
  const f = await fixture();
  try {
    const ref = (await f.prepare()).result as OwnerChildActionReference;
    const a = f.assign(ref, "child");
    await f.claim(a);
    const unguarded = f.makeExecution(false);
    await assert.rejects(
      f.db.transaction((tx) =>
        unguarded.authorize(tx, f.caller(a), {
          kind: "execution.claim",
          domain: "incarnation",
          key: ownerClaimKey(ownerId, a.assignmentId, a.sessionId),
          intent: { assignmentId: a.assignmentId, sessionId: a.sessionId },
        }, f.state.time)
      ),
      /Prepared input authority/,
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        unguarded.authorize(tx, f.caller(a), {
          kind: "execution.input",
          domain: "occurrence",
          key: "projection",
          intent: {
            executionId: ref.executionId,
            deliveryId: ref.deliveryId,
            dispatchAttemptId: a.dispatchAttemptId,
          },
        }, f.state.time)
      ),
      /Prepared input authority/,
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        unguarded.authorizeLive(tx, f.caller(a), f.state.time)
      ),
      /Prepared input authority/,
    );
    await f.complete(a);
    const children = f.makeChild(false);
    const intent = { parent: f.parentRef(), reference: ref };
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await children.authorize(tx, f.caller(), {
          kind: OWNER_CHILD_ACTION_RESULT,
          domain: "occurrence",
          key: "projection",
          intent,
        }, f.state.time);
        return await children.projection(intent, {
          tx,
          caller: f.caller(),
          commandTime: f.state.time,
          signal: new AbortController().signal,
        });
      }),
      /Prepared input authority/,
    );
  } finally {
    await f.close();
  }
});

test("every prepared child result rechecks original permission after the terminal read", async () => {
  const f = await fixture();
  try {
    for (
      const status of ["pending", "failed", "cancelled", "completed"] as const
    ) {
      f.state.originalAllowed = true;
      const ref = (await f.prepare(`result-${status}`))
        .result as OwnerChildActionReference;
      if (status !== "pending") {
        const a = f.assign(ref, `child-${status}`);
        await f.claim(a);
        await f.complete(
          a,
          status === "completed" ? { status, output: { ok: true } } : {
            status,
            code: status === "cancelled" ? "action_cancelled" : "action_failed",
          },
        );
      }
      f.state.revokeOnRead = `${ref.executionId}:action:terminal`;
      await assert.rejects(f.project(ref), /original source denied/);
      assert.equal(f.state.originalAllowed, false);
    }
  } finally {
    await f.close();
  }
});

test("duplicate preparation rechecks its current parent after original-reference authorization", async () => {
  const f = await fixture();
  try {
    const ref = (await f.prepare()).result as OwnerChildActionReference;
    const before = (await f.db.query("SELECT * FROM owner_receipts")).rows;
    f.state.duringResourceAuthorization = (purpose) => {
      if (purpose === "duplicate") f.state.ctx = false;
    };
    await assert.rejects(f.prepare(), /authority was revoked/);
    assert.equal(f.state.originalAllowed, true);
    assert.equal(f.state.resourceAllowed, true);
    assert.equal(f.state.rendered, 1);
    assert.equal(f.state.scheduled.length, 1);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_receipts")).rows,
      before,
    );
    assert.deepEqual(await f.input(ref), {
      text: "Reply: Title body original",
    });
  } finally {
    await f.close();
  }
});
