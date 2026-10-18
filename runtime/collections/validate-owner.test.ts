import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { defineCollection } from "./definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerCommandBoundary } from "../owner/boundary.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import { createOwnerCollectionCommand } from "../owner/collections.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { isNonRetryableError } from "../failure.ts";
import { isCollectionValidationError } from "./errors.ts";

test("owner Collection async schema refuses before any graph, event, receipt or sequence write", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const notes = defineCollection({
    name: "async_note",
    schema: {
      $async: true,
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
      required: ["id", "title"],
    } as const,
  });
  const registry = createPluginRegistry({ collections: { notes } });
  let scheduled = 0;
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "validation",
    workloads: {},
    scheduleDelivery() {
      scheduled++;
    },
    dispatchWork: () => Promise.reject(new Error("not available")),
    dispatchDelivery: () => Promise.reject(new Error("not available")),
    dispatchRecoverable: () => Promise.reject(new Error("not available")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const handler = createOwnerCollectionCommand({
    session: db,
    schema: "public",
    registry,
    collections: { notes },
    executor,
    scope: () => ({ namespace: "space" }),
  });
  const owner = createOwnerCommandBoundary({
    session: db,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    handlers: { collections: handler },
    authenticateReceipt() {
      throw new Error("No generic receipt authority in this fixture.");
    },
    authorize(_tx, caller) {
      if (caller.principal.kind !== "owner-control") {
        throw new Error("control required");
      }
    },
  });
  try {
    const epoch = await owner.acquire(0);
    await assert.rejects(
      owner.execute({
        principal: {
          kind: "owner-control",
          ownerId: "owner",
          epoch,
          holderId: "holder",
        },
        ownerEpoch: epoch,
      }, {
        kind: "collections",
        domain: "logical",
        key: "write",
        intent: {
          operations: [{
            collection: "notes",
            operation: "create",
            input: { id: "note", title: "valid value" },
          }],
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(isNonRetryableError(error));
        assert.equal(
          isCollectionValidationError(error),
          false,
          "unsupported schema is not a user input mismatch",
        );
        return true;
      },
    );
    for (
      const table of [
        "nodes",
        "edges",
        "events",
        "event_bodies",
        "event_deliveries",
        "owner_receipts",
        "owner_receipt_readers",
      ]
    ) {
      assert.equal(
        (await db.query(`SELECT 1 FROM ${table}`)).rows.length,
        0,
        table,
      );
    }
    assert.equal(
      String(
        (await db.query("SELECT last_seq FROM owner_epochs")).rows[0].last_seq,
      ),
      "0",
    );
    assert.equal(scheduled, 0);
    assert.equal(
      owner.state,
      "acquired",
      "known unsupported schema refusal does not retire owner",
    );
  } finally {
    owner.stop();
    await db.close();
  }
});
