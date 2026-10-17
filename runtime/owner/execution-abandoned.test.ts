import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "../actions/persistence.ts";
import { createActionLifecycleEmitter } from "../actions/lifecycle.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import { createEventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createOperationCatalog } from "../streams/catalog.ts";
import { ownerEffectKey } from "./effects-client.ts";
import { fixture, start } from "./execution.fixture.test.ts";

test("normal delivery settlement retains and classifies abandoned nested Action effect evidence", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    const effect = { namespace: "space", actionRunId: "nested", step: "send" };
    await f.db.transaction(async (tx) => {
      const catalog = createOperationCatalog(f.db, "public");
      const ownerCommit = {
        transaction: tx,
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        commandTime: start,
        ownerAttempt: {
          deliveryId: f.reference().deliveryId,
          attemptId: f.reference().dispatchAttemptId,
        },
        afterCommit() {
          throw new Error("seed must not publish");
        },
      };
      const store = createEventStore({
        session: f.db,
        schema: "public",
        ownerCommit,
        admitOperationEventSql: (input, param) =>
          catalog.admitEventSql(input, param),
        indexOperationEvent: (transaction, input) =>
          catalog.indexEvent(transaction, input),
        indexOperationEventSql: (input, param) =>
          catalog.indexEventSql(input, param),
      });
      const executor = {
        scheduleDelivery() {
          throw new Error("seed must not dispatch");
        },
      } as unknown as DeliveryExecutor;
      const coordinator = createEventCoordinator({
        store,
        registry: f.registry,
        executor,
        scheduleOnly: true,
      });
      const lifecycle = createActionLifecycleEmitter({
        namespace: "space",
        metadata: { sourceDeliveryId: f.reference().deliveryId },
        append: createActionLifecycleAppender({
          schema: "public",
          store,
          coordinator,
          actions: f.registry.actions,
          transaction: tx,
          commandTime: start,
          ownerAuthority: ownerCommit,
          writer: {
            kind: "owner-attempt",
            deliveryId: f.reference().deliveryId,
            attemptId: f.reference().dispatchAttemptId,
          },
        }),
      });
      await lifecycle.emit({
        status: "invoked",
        actionId: "fixture.work",
        actionRunId: "nested",
        parentActionRunId: "run",
        input: "world",
        metadata: {},
        settlementScopeId: f.source.event.id,
        causationId: f.source.event.id,
        correlationId: f.source.event.correlationId,
        deduplicationId: "nested:action:invoked",
      });
      await tx.query(
        "INSERT INTO owner_receipts(owner,principal_kind,principal_id,domain,key,kind,intent,result) VALUES('owner','worker','[\"worker\"]','logical',$1,'effect.begin',$2::jsonb,$3::jsonb)",
        [
          ownerEffectKey("owner", effect, "begin"),
          JSON.stringify(effect),
          JSON.stringify({ ...effect, status: "begun" }),
        ],
      );
    });
    const before = (await f.db.query(
      "SELECT * FROM owner_receipts WHERE kind='effect.begin'",
    )).rows;
    await f.port().complete(f.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    const nested = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "nested:action:terminal",
    );
    assert.equal(nested?.status, "failed");
    if (nested?.status === "failed") {
      assert.equal(nested.error?.code, "effect_indeterminate");
    }
    assert.deepEqual(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='effect.begin'",
      )).rows,
      before,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});
