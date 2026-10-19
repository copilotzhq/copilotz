import { assertEquals, assertExists, assertRejects } from "@std/assert";
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
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineAction } from "./define.ts";
import { settleActionAuthorizationRefusal } from "./authorization-refusal.ts";
import { type ActionInvocationFrame, createActionCallers } from "./invoker.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { ActionOwnershipLost } from "./ownership.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "./persistence.ts";
import { createProtectedActions } from "./protected-actions.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test({
  name:
    "PostgreSQL protected retained results require a current parent attempt, source and policy but no open child Action",
  ignore: !url,
  async fn(t) {
    const db = await createTestDatabase({ url: url! });
    const schema = `protected_authority_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    await provisionCopilotzSchema(db, schema);
    let time = Date.UTC(2000, 0, 1);
    const owner = await openDatabaseOwner(db, schema, {
      now: () => new Date(time),
    });
    await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const store = createEventStore({
      session: db,
      schema,
      admitOperationEventSql: (input, param) =>
        catalog.admitEventSql(input, param),
      indexOperationEventSql: (input, param) =>
        catalog.indexEventSql(input, param),
    });
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
    const action = defineAction({
      id: "test.protected",
      ownerHooks: { prepareInput: true },
      inputSchema: { type: "number" } as const,
      outputSchema: { type: "number" } as const,
      execute: (value) => value,
    });
    try {
      const root = await store.commitMutation({
        draft: {
          namespace: "space",
          type: "test.source",
          payload: {
            dataRef: {
              eventBodyId: "source",
              schemaVersion: 1,
              mediaType: "application/json",
            },
          },
        },
        body: { id: "source", json: { principal: "member" } },
        consumers: [{ consumerId: "processor", settlement: "inherit" }],
      });
      const id = root.deliveries[0].id;
      assertExists(
        await store.claimDelivery({ id, owner: "attempt", leaseMs: 1000 }),
      );
      const writer = {
        kind: "delivery" as const,
        deliveryId: id,
        leaseOwner: "attempt",
      };
      const source = { eventId: root.event.id, operationId: root.event.id };
      const controller = new AbortController();
      const frame: ActionInvocationFrame = {
        actionId: action.id,
        actionRunId: "child",
        rootKey: "root",
        operationKey: "child",
        metadata: {},
        identity: { settlementScopeId: root.event.id },
        signal: controller.signal,
        nextActionIndex: () => 1,
      };
      let allowed = true, authorized = 0, prepared = 0;
      const make = (binding = source, attempt = writer) =>
        createProtectedActions({
          definitions: {
            [action.id]: {
              async authorize(_input, context) {
                authorized++;
                assertEquals((await context.resolveSource()).data, {
                  principal: "member",
                });
                if (!allowed) throw new Error("permission revoked");
              },
              prepareInput(input) {
                prepared++;
                return input;
              },
            },
          },
          actions: { action },
          store,
          coordinator,
          operationCatalog: catalog,
          namespace: "space",
          source: binding,
          writer: attempt,
          signal: controller.signal,
        });
      const hooks = make();
      const run = createSchemaCommandRunner(db, schema);
      const authorize = (outputHooks = hooks) =>
        run(
          "test.authorize",
          {},
          (_, command) =>
            outputHooks.output(frame).authorize!(command.transaction),
        );
      const lifecycle = createActionLifecycleEmitter({
        namespace: "space",
        append: createActionLifecycleAppender({
          store,
          coordinator,
          actions: { action },
          writer,
        }),
        load: createActionLifecycleLoader({ store, actions: { action } }),
      });
      await t.step(
        "capture precedes open Action and keeps the command clock",
        async () => {
          assertEquals(await hooks.prepareInput(frame, 7), {
            input: 7,
            claimed: true,
          });
          assertEquals(prepared, 1);
          await authorize();
        },
      );
      await t.step(
        "lifecycle ownership uses captured earlier/equality/later boundaries",
        async () => {
          const start = time;
          const deadline = start + 1000;
          for (const offset of [-1, 0, 1]) {
            time = deadline + offset;
            const emit = () =>
              lifecycle.emit({
                actionId: action.id,
                actionRunId: frame.actionRunId,
                metadata: {},
                input: 7,
                status: "progress",
                progress: offset,
                progressIndex: offset + 2,
                settlementScopeId: root.event.id,
                deduplicationId: `child:action:progress:${offset + 2}`,
              });
            if (offset < 0) await emit();
            else await assertRejects(emit, ActionOwnershipLost);
          }
          time = start;
          assertEquals(
            (await store.listEvents({ namespace: "space" })).filter((event) =>
              event.type.endsWith(".progress")
            ).length,
            1,
          );
        },
      );
      await t.step(
        "refusal cleanup and continuation admission use the same command clock",
        async () => {
          const refused = { ...frame, actionRunId: "refused-child" };
          await hooks.prepareInput(refused, 7);
          const refuse = () =>
            settleActionAuthorizationRefusal({
              store,
              coordinator,
              namespace: "space",
              source,
              writer,
              actions: { action },
            }, refused);
          const start = time;
          time += 1000;
          await assertRejects(refuse, ActionOwnershipLost);
          time = start;
          assertEquals((await refuse()).settled, true);
          assertEquals(
            (await lifecycle.terminal(refused.actionRunId))?.status,
            "failed",
          );
          const awaiting = { ...frame, actionRunId: "awaiting-child" };
          await hooks.prepareInput(awaiting, 7);
          await lifecycle.emit({
            actionId: action.id,
            actionRunId: awaiting.actionRunId,
            metadata: {},
            input: 7,
            status: "awaiting",
            progressIndex: 0,
            handoff: {},
            start: { action: "action", input: 7 },
            settlementScopeId: root.event.id,
            deduplicationId: "awaiting-child:action:awaiting",
          });
          assertEquals(
            (await lifecycle.awaiting!(awaiting.actionRunId))?.status,
            "awaiting",
          );
          assertExists(
            await catalog.get("space", "awaiting-child:child"),
          );
        },
      );
      await t.step(
        "stale attempt and wrong retained source cannot prepare",
        async () => {
          await assertRejects(
            () =>
              make(source, { ...writer, leaseOwner: "stale" }).prepareInput(
                frame,
                7,
              )!,
            ActionOwnershipLost,
          );
          await assertRejects(
            () =>
              make({ ...source, eventId: "other-event" }).prepareInput(
                frame,
                7,
              )!,
            ActionOwnershipLost,
          );
          await assertRejects(
            () =>
              make({ ...source, operationId: "other-operation" }).prepareInput(
                frame,
                7,
              )!,
            ActionOwnershipLost,
          );
        },
      );
      await t.step(
        "completed child replays after its open obligation closes",
        async () => {
          const before = prepared;
          await lifecycle.emit({
            actionId: action.id,
            actionRunId: frame.actionRunId,
            metadata: {},
            input: 7,
            output: 9,
            status: "completed",
            settlementScopeId: root.event.id,
            deduplicationId: "child:action:terminal",
          });
          assertEquals(
            (await db.query(
              `SELECT 1 FROM ${store.tables.open_actions} WHERE action_run_id='child'`,
            )).rows,
            [],
          );
          assertEquals(await hooks.prepareInput(frame, 7), {
            input: 7,
            claimed: false,
          });
          const purposes: string[] = [];
          const callers = createActionCallers({ action }, {
            actionLifecycle: lifecycle,
            prepareInput: hooks.prepareInput,
            authorize(currentFrame, purpose, transaction) {
              purposes.push(purpose);
              const authorize = hooks.output(currentFrame).authorize!;
              return transaction ? authorize(transaction) : run(
                "test.replayAuthorization",
                {},
                (_, command) => authorize(command.transaction),
              );
            },
            createInvocationKey: () => frame.actionRunId,
            identity: frame.identity,
            signal: controller.signal,
            createContext() {
              throw new Error("A completed replay must not execute again.");
            },
          });
          assertEquals(await callers.action(7), 9);
          assertEquals(purposes, ["input", "result"]);
          assertEquals(
            (await lifecycle.terminal("child"))?.status,
            "completed",
          );
          assertEquals(prepared, before);
        },
      );
      await t.step(
        "committed cancellation blocks new work before the signal arrives",
        async () => {
          await db.query(
            `UPDATE ${
              createOperationCatalogTables(schema).operations
            } SET cancellation_requested_at=NOW() WHERE operation_id=$1`,
            [root.event.id],
          );
          assertEquals(controller.signal.aborted, false);
          await assertRejects(
            () =>
              hooks.prepareInput({ ...frame, actionRunId: "new-child" }, 7)!,
            ActionOwnershipLost,
          );
          // An unpropagated signal cannot preserve result-disclosure authority.
          const before = authorized;
          await assertRejects(() => authorize(), ActionOwnershipLost);
          assertEquals(authorized, before);
        },
      );
      await t.step(
        "retained result requires exact live parent authority and current policy",
        async () => {
          await db.query(
            `UPDATE ${
              createOperationCatalogTables(schema).operations
            } SET cancellation_requested_at=NULL WHERE operation_id=$1`,
            [root.event.id],
          );
          const other = await store.append({
            namespace: "space",
            type: "test.other",
            payload: {},
          });
          const start = time;
          for (const offset of [-1, 0, 1]) {
            time = start + 1000 + offset;
            if (offset < 0) await authorize();
            else await assertRejects(() => authorize(), ActionOwnershipLost);
          }
          time = start;
          await assertRejects(
            () => authorize(make(source, { ...writer, leaseOwner: "stale" })),
            ActionOwnershipLost,
          );
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET owner_epoch=0 WHERE id=$1`,
            [id],
          );
          await assertRejects(() => authorize(), ActionOwnershipLost);
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET owner_epoch=$2, event_id=$3 WHERE id=$1`,
            [id, owner.epoch, other.event.id],
          );
          await assertRejects(() => authorize(), ActionOwnershipLost);
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET event_id=$2 WHERE id=$1`,
            [id, root.event.id],
          );
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET settlement_scope_id=$2 WHERE id=$1`,
            [id, other.event.id],
          );
          await assertRejects(() => authorize(), ActionOwnershipLost);
          await db.query(
            `UPDATE ${store.tables.event_deliveries} SET settlement_scope_id=$2 WHERE id=$1`,
            [id, root.event.id],
          );
          const before = authorized;
          await authorize();
          assertEquals(authorized, before + 1);
          allowed = false;
          await assertRejects(
            () => authorize(),
            Error,
            "owner phase failed",
          );
        },
      );
    } finally {
      releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
