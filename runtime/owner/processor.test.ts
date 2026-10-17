import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { markNonRetryable } from "../failure.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { processorFixture, processorStart } from "./processor.fixture.test.ts";

test("registered Processor uses real delivery and owner Collections without Action metadata or database capabilities", async () => {
  const f = await processorFixture();
  try {
    const worker = f.worker();
    const result = await worker.execute(f.hint());
    assert.equal(result.status, "executed");
    assert.equal(result.receipt.status, "succeeded");
    assert.equal(f.state.executions, 1);
    assert.equal(f.state.persistenceOpens, 0);
    assert.equal((await f.store.getDelivery(f.source.deliveryId))?.attempts, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
    const events =
      (await f.db.query<{ type: string; seq: string; causation_id: string }>(
        "SELECT type,seq,causation_id FROM events ORDER BY seq",
      )).rows;
    assert.deepEqual(events.map((event) => event.type), [
      "fixture.source",
      "note.created",
    ]);
    assert.deepEqual(events.map((event) => Number(event.seq)), [1, 2]);
    assert.equal(events[1].causation_id, f.source.eventId);
    assert.deepEqual(f.state.published, ["note.created"]);
    assert.equal(f.state.schedules.length, 2);
    f.state.ctx = false;
    assert.equal((await worker.execute(f.hint())).status, "replayed");
    assert.equal((await f.worker().execute(f.hint())).status, "replayed");
    assert.equal(f.state.executions, 1);
    f.state.receipt = false;
    await assert.rejects(worker.execute(f.hint()), /receipt refused/);
  } finally {
    await f.close();
  }
});

test("Processor retries preserve delivery business identity and actual backoff", async () => {
  let attempts = 0;
  const f = await processorFixture({
    afterWrite() {
      if (++attempts === 1) throw new Error("retry me");
    },
  });
  try {
    const first = await f.worker().execute(f.hint());
    assert.equal(first.receipt.status, "retry_wait");
    const delivery = await f.store.getDelivery(f.source.deliveryId);
    assert.ok(delivery);
    assert.equal(delivery.attempts, 1);
    assert.deepEqual(f.state.retryWakes, [delivery.availableAt]);
    f.state.time = new Date(Date.parse(delivery.availableAt) + 1).toISOString();
    f.replace();
    const next = await f.worker().execute(f.hint());
    assert.equal(next.receipt.status, "succeeded");
    assert.equal((await f.store.getDelivery(f.source.deliveryId))?.attempts, 2);
    assert.equal(
      (await f.db.query("SELECT * FROM nodes WHERE type='note'")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM events WHERE type='note.created'")).rows
        .length,
      1,
    );
    assert.deepEqual(f.state.published, ["note.created"]);
  } finally {
    await f.close();
  }
});

test("Processor onError acknowledges a known no-write transaction failure after owner failure writes commit", async () => {
  let handled = 0;
  const f = await processorFixture({
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      async handle(_event, ctx) {
        await ctx.transaction(() => {
          throw markNonRetryable(new Error("known no-write failure"));
        }, { operationKey: "failed" });
      },
      async onError(_error, _event, ctx) {
        handled++;
        await ctx.transaction(
          ({ collections }) =>
            collections.notes.create({ id: "failure", title: "handled" }),
          {
            operationKey: "failure",
          },
        );
        return true;
      },
    }),
  });
  try {
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "succeeded",
    );
    assert.equal(handled, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM nodes WHERE id='failure'")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Processor onError cannot hide another unawaited failure or a newly raised failure", async () => {
  for (const mode of ["parallel", "new"] as const) {
    const f = await processorFixture({
      processor: defineProcessor({
        id: "fixture.observe",
        on: [{ eventType: "fixture.source" }],
        async handle(_event, ctx) {
          if (mode === "parallel") {
            void ctx.transaction(() => {
              throw new Error("parallel failure");
            }, { operationKey: "parallel" });
          }
          await ctx.transaction(() => {
            throw markNonRetryable(new Error("handled failure"));
          }, { operationKey: "handled" });
        },
        onError(_error, _event, ctx) {
          if (mode === "new") {
            void ctx.transaction(() => {
              throw new Error("onError failure");
            }, { operationKey: "on-error" });
          }
          return true;
        },
      }),
    });
    try {
      assert.notEqual(
        (await f.worker().execute(f.hint())).receipt.status,
        "succeeded",
      );
    } finally {
      await f.close();
    }
  }
});

test("Processor unknown pending command refuses settlement and never reaches onError", async () => {
  let handled = 0;
  const f = await processorFixture({
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      async handle(_event, ctx) {
        void ctx.transaction(() => {
          throw Object.assign(new Error("unknown"), { outcome: "unknown" });
        }, { operationKey: "unknown" });
        await ctx.transaction(() => {
          throw markNonRetryable(new Error("known"));
        }, { operationKey: "known" });
      },
      onError() {
        handled++;
        return true;
      },
    }),
  });
  try {
    await assert.rejects(f.worker().execute(f.hint()), /unknown/);
    assert.equal(handled, 0);
    assert.equal(
      (await f.store.getDelivery(f.source.deliveryId))?.status,
      "leased",
    );
  } finally {
    await f.close();
  }
});

test("Processor onError runs only after retries are exhausted or explicitly nonretryable", async () => {
  let handled = 0;
  const f = await processorFixture({
    maxAttempts: 2,
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      handle() {
        throw new Error("ordinary failure");
      },
      onError() {
        handled++;
        return false;
      },
    }),
  });
  try {
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "retry_wait",
    );
    assert.equal(handled, 0);
    const prior = await f.store.getDelivery(f.source.deliveryId);
    f.state.time = new Date(Date.parse(prior!.availableAt) + 1).toISOString();
    f.replace();
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "dead_letter",
    );
    assert.equal(handled, 1);
  } finally {
    await f.close();
  }
});

test("Processor claim rollback has no visible lease, receipt, or afterCommit scheduling", async () => {
  const f = await processorFixture();
  try {
    f.state.rollback = true;
    await assert.rejects(
      f.boundary.execute(f.caller(), f.claimCommand()),
      /unknown/,
    );
    const delivery = await f.store.getDelivery(f.source.deliveryId);
    assert.equal(delivery?.status, "pending");
    assert.equal(delivery?.attempts, 0);
    assert.deepEqual(f.state.schedules, []);
    assert.equal(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='processor.claim'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Processor unknown claim never hydrates or reruns, while unknown completion can recover a safe receipt", async () => {
  for (const stage of ["claim", "complete"] as const) {
    const f = await processorFixture();
    try {
      if (stage === "claim") f.state.unknownClaim = true;
      else f.state.unknownComplete = true;
      const worker = f.worker();
      await assert.rejects(worker.execute(f.hint()), /lost/);
      await assert.rejects(worker.execute(f.hint()), /lost/);
      if (stage === "claim") {
        assert.equal(f.state.executions, 0);
        await assert.rejects(f.worker().execute(f.hint()), /replay_refused/);
      } else {
        assert.equal(f.state.executions, 1);
        const replay = await f.worker().execute(f.hint());
        assert.equal(replay.status, "replayed");
        assert.equal(replay.receipt.status, "succeeded");
      }
    } finally {
      await f.close();
    }
  }
});

test("Processor current ctx/event/session/attempt fencing precedes projection and owner effects", async () => {
  for (
    const field of [
      "ctx",
      "event",
      "live",
      "attempt",
      "processor",
      "source",
    ] as const
  ) {
    const f = await processorFixture();
    try {
      if (field === "attempt") {
        await assert.rejects(
          f.port({ ...f.caller(), dispatchAttemptId: "foreign" }).claim(
            f.hint(),
            {},
          ),
        );
      } else {
        if (field === "processor") f.replace({ processorId: "foreign" });
        else if (field === "source") f.replace({ sourceEventId: "foreign" });
        else f.state[field] = false;
        await assert.rejects(f.worker().execute(f.hint()));
      }
      assert.equal(
        (await f.store.getDelivery(f.source.deliveryId))?.status,
        "pending",
      );
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

test("Processor protected and ContentRef event input is refused before a fresh claim", async () => {
  const f = await processorFixture({
    data: {
      schema: "copilotz.event.protected-value.v1",
      data: { title: "private" },
      protected: {},
    },
  });
  try {
    await assert.rejects(f.worker().execute(f.hint()), /protected/);
    assert.equal(
      (await f.store.getDelivery(f.source.deliveryId))?.status,
      "pending",
    );
    assert.equal(f.state.executions, 0);
  } finally {
    await f.close();
  }
});

test("Processor detached delivery uses its own original settlement scope for owner writes", async () => {
  const f = await processorFixture({ detached: true, observeWrites: true });
  try {
    const delivery = await f.store.getDelivery(f.source.deliveryId);
    assert.notEqual(delivery?.settlementScopeId, f.source.eventId);
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "succeeded",
    );
    const event = (await f.db.query<{ settlement_scope_id: string }>(
      "SELECT d.settlement_scope_id FROM event_deliveries d JOIN events e ON e.id=d.event_id WHERE e.type='note.created'",
    )).rows[0];
    assert.equal(event.settlement_scope_id, delivery?.settlementScopeId);
    assert.deepEqual(f.state.schedules, [
      delivery!.settlementScopeId,
      delivery!.settlementScopeId,
    ]);
  } finally {
    await f.close();
  }
});

test("Processor cancellation skips onError and settlement remains available after ctx revocation", async () => {
  for (const cancel of [true, false]) {
    let handled = 0;
    const control = new AbortController();
    const f = await processorFixture({
      processor: defineProcessor({
        id: "fixture.observe",
        on: [{ eventType: "fixture.source" }],
        handle() {
          f.state.ctx = false;
          if (cancel) {
            control.abort();
            throw markNonRetryable(new Error("cancelled handler"));
          }
        },
        onError() {
          handled++;
          return true;
        },
      }),
    });
    try {
      const result = await f.worker().execute(f.hint(), {
        signal: control.signal,
      });
      assert.equal(result.receipt.status, cancel ? "cancelled" : "succeeded");
      assert.equal(handled, 0);
    } finally {
      await f.close();
    }
  }
});

test("Processor completion respects current operation cancellation and expired attempt authority", async () => {
  for (const mode of ["cancelled", "expired"] as const) {
    const f = await processorFixture({
      afterWrite: async () => {
        if (mode === "expired") {
          f.state.time = new Date(Date.parse(processorStart) + 1001)
            .toISOString();
        } else {await f.db.query(
            "UPDATE copilotz_operations SET cancellation_requested_at=$1::timestamptz WHERE operation_id=$2",
            [processorStart, f.source.eventId],
          );}
      },
    });
    try {
      await assert.rejects(
        f.worker().execute(f.hint()),
        mode === "expired" ? /lease/ : /cancellation/,
      );
      assert.equal(
        (await f.store.getDelivery(f.source.deliveryId))?.status,
        "leased",
      );
    } finally {
      await f.close();
    }
  }
});

test("Processor long handler renews its real delivery and unknown renewal never settles or reruns", async () => {
  for (const unknown of [false, true]) {
    const clock = { started: undefined as number | undefined };
    let aborted = false;
    const f = await processorFixture({
      leaseMs: 100,
      now: () =>
        clock.started === undefined ? processorStart : new Date(
          Date.parse(processorStart) +
            Math.floor(performance.now() - clock.started),
        ).toISOString(),
      async afterWrite(ctx) {
        await delay(250);
        aborted = ctx.signal.aborted;
      },
    });
    clock.started = performance.now();
    try {
      f.state.unknownRenewal = unknown;
      const worker = f.worker();
      if (unknown) {
        await assert.rejects(worker.execute(f.hint()), /renewal/);
        await assert.rejects(worker.execute(f.hint()), /renewal/);
        assert.equal(aborted, true);
        assert.equal(
          (await f.store.getDelivery(f.source.deliveryId))?.status,
          "leased",
        );
      } else {assert.equal(
          (await worker.execute(f.hint())).receipt.status,
          "succeeded",
        );}
      assert.ok(f.state.renewals >= 1);
      assert.equal(f.state.executions, 1);
      assert.equal(
        (await f.store.getDelivery(f.source.deliveryId))?.attempts,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("Processor completion refuses coerced failure codes without changing delivery or receipts", async () => {
  const f = await processorFixture();
  try {
    const port = f.port();
    const claimed = await port.claim(f.hint(), {});
    const before = await f.store.getDelivery(f.source.deliveryId);
    const receipts = async () =>
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='processor.complete'",
      )).rows;
    assert.deepEqual(await receipts(), []);
    for (
      const code of [
        ["processor_capability_unsupported"],
        ["processor_failed"],
        1,
        null,
        {},
      ]
    ) {
      await assert.rejects(
        port.complete(claimed.result, {
          status: "failed",
          code,
          retryable: true,
        } as never, {}),
        /Invalid safe Processor failure/,
      );
      assert.deepEqual(await f.store.getDelivery(f.source.deliveryId), before);
      assert.deepEqual(await receipts(), []);
    }
  } finally {
    await f.close();
  }
});

test("Processor event revocation fences new owner writes and receipt replay under a live ctx lease", async () => {
  const f = await processorFixture();
  try {
    const port = f.port();
    const claimed = await port.claim(f.hint(), {});
    await port.project(claimed.result, {});
    const command = {
      kind: "collections",
      domain: "logical" as const,
      key: `delivery:${f.source.deliveryId}:write`,
      intent: {
        operations: [{
          collection: "notes",
          operation: "create",
          input: { id: "before", title: "ordinary" },
        }],
      },
    };
    assert.equal((await port.execute(command)).status, "committed");
    const before = await f.store.getDelivery(f.source.deliveryId);
    const receipts = (await f.db.query(
      "SELECT * FROM owner_receipts WHERE kind='collections'",
    )).rows;
    f.state.event = false;
    assert.equal(f.state.ctx, true);
    await assert.rejects(port.execute(command), /event authority revoked/);
    await assert.rejects(
      port.execute({
        ...command,
        key: `${command.key}:new`,
        intent: {
          operations: [{
            collection: "notes",
            operation: "create",
            input: { id: "after", title: "forbidden" },
          }],
        },
      }),
      /event authority revoked/,
    );
    assert.deepEqual(await f.store.getDelivery(f.source.deliveryId), before);
    assert.deepEqual(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='collections'",
      )).rows,
      receipts,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM nodes WHERE id='after'")).rows.length,
      0,
    );
    assert.equal(
      (await port.complete(claimed.result, { status: "succeeded" }, {})).result
        .status,
      "succeeded",
    );
  } finally {
    await f.close();
  }
});
