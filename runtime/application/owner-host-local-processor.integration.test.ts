/** Actual SQL/boundary/helper composition. These holds occur after execute()
 * returns its committed outcome, so unrelated owner commands remain runnable. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommandContext,
} from "../owner/boundary.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import { provisionOwnerAssignments } from "../owner/assignments.ts";
import { createOwnerProcessorCommands } from "../owner/processor.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "../owner/placement-binding.ts";
import { createOwnerHostCommandContexts } from "./owner-host-local.ts";
import {
  captureOwnerHostLocalProcessors,
  createOwnerHostLocalProcessors,
} from "./owner-host-local-processor.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => resolve = yes);
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("held reply fixture timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
}
async function fixture(stage: "start" | "completion") {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const control: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    privateHostControl: crypto.randomUUID(),
  };
  const committed = deferred(), release = deferred();
  let current = true, time = "2020-01-01T00:00:00.000001Z", held = false;
  let reference: OwnerLocalProcessorAssignmentBinding | undefined;
  const stats = {
    active: 0,
    released: 0,
    factories: 0,
    authored: 0,
    wakes: 0,
    scans: 0,
  };
  const registry = createPluginRegistry({
    processors: {
      follow: defineProcessor({
        id: "helper.follow",
        on: [{ eventType: "helper.input" }],
        handle() {
          stats.authored++;
          if (stage === "completion" && stats.authored === 1) {
            throw new Error("retry first attempt");
          }
        },
      }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const contexts = createOwnerHostCommandContexts({
    ownerId: "owner",
    holderId: "holder",
    epoch: () => 1,
    isCurrent: () => current,
  });
  const assertControl = (who: OwnerCaller) => {
    assert.equal(current, true);
    assert.deepEqual(who.principal, control.principal);
    assert.equal(who.ownerEpoch, 1);
    assert.equal(who.privateHostControl, control.privateHostControl);
  };
  const processor = createOwnerProcessorCommands({
    ownerId: "owner",
    schema: "public",
    session: db,
    registry,
    catalog,
    resolveAssignment: () => undefined,
    authorizeEvent() {
      throw new Error("worker forbidden");
    },
    scheduleSettlement() {},
    async scheduleRetry(context, delivery) {
      assert.equal(await helper.retryNamespace(context, delivery), "space");
    },
    local: {
      resolveAssignment: (tx, caller, time) => helper.resolve(tx, caller, time),
      authorizeStart: (...args) => helper.processor.authorizeStart(...args),
      authorizeEvent: (...args) => helper.event(...args),
      isCurrent: (...args) => helper.processor.isCurrent(...args),
      reserveLocal: (...args) => helper.processor.reserveLocal(...args),
      retireLocal: (...args) => helper.processor.retireLocal(...args),
    },
  });
  const boundary = createOwnerCommandBoundary({
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    session: db,
    now: () => time,
    handlers: {
      ...Object.fromEntries(
        Object.entries(processor.handlers).map((
          [kind, handler],
        ) => [
          kind,
          (
            intent: Parameters<typeof handler>[0],
            context: OwnerCommandContext,
          ) => contexts.run(context, () => handler(intent, context)),
        ]),
      ),
      async seed(_intent, context) {
        const seeded = await createEventStore({
          session: db,
          ownerCommit: context.ownerCommit,
          admitOperationEventSql: catalog.admitEventSql.bind(catalog),
          indexOperationEventSql: catalog.indexEventSql.bind(catalog),
          indexOperationEvent: catalog.indexEvent.bind(catalog),
        }).commitMutation({
          transaction: context.tx,
          draft: {
            type: "helper.input",
            namespace: "space",
            payload: {
              dataRef: {
                eventBodyId: "helper-body",
                schemaVersion: 1,
                mediaType: "application/json",
              },
            },
            metadata: {},
            deduplicationId: "helper-input",
            correlationId: "helper-correlation",
          },
          body: { id: "helper-body", json: null },
          consumers: [{
            consumerId: "processor:helper.follow",
            settlement: "inherit",
          }],
        });
        return {
          eventId: seeded.event.id,
          deliveryId: seeded.deliveries[0].id,
        };
      },
      scan(_intent, context) {
        return contexts.run(context, async () => {
          assert.ok(reference);
          stats.scans++;
          assert.equal(contexts.isCurrent({ ...context }), false);

          const row = (await context.tx.query(
            "SELECT status,attempts,available_at::text AS available_at,available_at<=$2::timestamptz AS due FROM event_deliveries WHERE id=$1",
            [reference.deliveryId, context.commandTime],
          )).rows[0];
          return {
            status: String(row.status),
            attempts: Number(row.attempts),
            availableAt: String(row.available_at),
            due: row.due === true,
          };
        });
      },
    },
    projections: processor.projections,
    authorize(tx, who, command, at) {
      return contexts.authorize(tx, who, command, at, async () => {
        if (command.kind === "seed" || command.kind === "scan") {
          assertControl(who);
        } else await processor.authorize(tx, who, command, at);
      });
    },
    authenticateReceipt() {
      throw new Error("recovery forbidden");
    },
  });
  await boundary.acquire(0);
  const seeded = (await boundary.execute(control, {
    kind: "seed",
    domain: "logical",
    key: "helper-seed",
    intent: null,
  })).result as { eventId: string; deliveryId: string };
  const helper: ReturnType<typeof createOwnerHostLocalProcessors> =
    createOwnerHostLocalProcessors({
      configuration: captureOwnerHostLocalProcessors({
        processorIds: ["helper.follow"],
        policy: {
          grants: () => ({ ctx: true, settlement: true }),
          event() {},
          collections: () => ({}),
        },
        createCapabilities() {
          stats.factories++;
          return { resources: {}, adapters: {} };
        },
      }, registry),
      registry,
      schema: "public",
      controlCaller: control,
      maxActive: 1,
      contexts,
      assertControl,
      isCurrent: () => current,
      onIndeterminate(error) {
        current = false;
        helper.stop(error);
      },
      requestWake() {
        stats.wakes++;
      },
      capacity: {
        reserve(binding) {
          assert.equal(stats.active, 0);
          reference = structuredClone(binding);
          stats.active++;
          return {
            release() {
              assert.equal(stats.active, 1);
              stats.active--;
              stats.released++;
            },
          };
        },
      },
      boundary: {
        async execute(who, command, options) {
          const result = await boundary.execute(who, command, options);
          if (
            !held &&
            command.kind ===
              (stage === "start"
                ? "owner.local-processor-start"
                : "processor.local-complete")
          ) {
            held = true;
            committed.resolve();
            await release.promise;
          }
          return result;
        },
        project: (...args) => boundary.project(...args),
        executeInput: (...args) => boundary.executeInput(...args),
      },
    });
  const scheduled = {
    kind: "processor" as const,
    processorId: "helper.follow",
    namespace: "space",
    sourceEventId: seeded.eventId,
    deliveryId: seeded.deliveryId,
  };
  const running = outcome(helper.run(scheduled));
  return {
    db,
    helper,
    stats,
    committed,
    release,
    running,
    scheduled,
    advance(at: string) {
      time = at;
    },
    scan: () =>
      boundary.execute(control, {
        kind: "scan",
        domain: "occurrence",
        key: crypto.randomUUID(),
        intent: null,
      }),
    async close() {
      release.resolve();
      current = false;
      helper.stop();
      boundary.stop();
      await running;
      await db.close();
    },
  };
}

test("local Processor actual helper permits authenticated scans during held caller-facing start reply without opening invocation", async () => {
  const f = await fixture("start");
  try {
    await bounded(f.committed.promise);
    assert.equal(f.stats.active, 1);
    assert.equal(f.stats.factories, 0);
    assert.equal(f.stats.authored, 0);
    const first = await bounded(f.scan()), second = await bounded(f.scan());
    assert.equal((first.result as { status: string }).status, "leased");
    assert.equal((second.result as { status: string }).status, "leased");
    assert.equal(f.stats.scans, 2);
    assert.equal(f.stats.factories, 0);
    assert.equal(f.stats.released, 0);
    f.release.resolve();
    assert.equal((await bounded(f.running)).error, undefined);
    assert.equal(f.stats.factories, 1);
    assert.equal(f.stats.authored, 1);
    assert.equal(f.stats.active, 0);
    assert.equal(f.stats.released, 1);
  } finally {
    await f.close();
  }
});

test("local Processor actual helper refuses due successor while committed completion reply is held and admits it only after known receipt and drain", async () => {
  const f = await fixture("completion");
  try {
    await bounded(f.committed.promise);
    const first = (await bounded(f.scan())).result as {
      status: string;
      availableAt: string;
    };
    assert.equal(first.status, "retry_wait");
    assert.equal(f.stats.active, 1);
    assert.equal(f.stats.authored, 1);
    assert.equal(f.stats.wakes, 0);
    f.advance(
      new Date(new Date(first.availableAt).getTime() + 1).toISOString(),
    );
    const due = (await bounded(f.scan())).result as {
      status: string;
      due: boolean;
      attempts: number;
    };
    assert.equal(due.due, true);
    assert.equal(due.attempts, 1);
    await assert.rejects(f.helper.run(f.scheduled));
    assert.equal(f.stats.authored, 1);
    assert.equal(f.stats.active, 1);
    f.release.resolve();
    assert.equal((await bounded(f.running)).error, undefined);
    assert.equal(f.stats.active, 0);
    assert.equal(f.stats.released, 1);
    assert.equal(f.stats.wakes, 1);
    await bounded(f.helper.run(f.scheduled));
    assert.equal(f.stats.authored, 2);
    assert.equal(f.stats.factories, 2);
    assert.equal(f.stats.released, 2);
    assert.equal(f.stats.active, 0);
    const row = (await f.db.query(
      "SELECT status,attempts FROM event_deliveries WHERE id=$1",
      [f.scheduled.deliveryId],
    )).rows[0];
    assert.equal(row.status, "succeeded");
    assert.equal(row.attempts, 2);
  } finally {
    await f.close();
  }
});
