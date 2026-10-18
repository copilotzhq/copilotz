import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerAuthorityLock } from "./authority-read.ts";
import { fixture } from "./execution.fixture.test.ts";
import { processorFixture } from "./processor.fixture.test.ts";
import type { SqlExecutor } from "../events/session.ts";

test("authority lock mode keeps explicit normal locks and refuses unknown modes", () => {
  for (
    const clause of [
      " FOR UPDATE",
      " FOR UPDATE OF d",
      " FOR SHARE",
      " FOR SHARE OF a",
    ] as const
  ) {
    assert.equal(ownerAuthorityLock("locking", clause), clause);
    assert.equal(ownerAuthorityLock("exclusive-read", clause), "");
    assert.throws(() => ownerAuthorityLock("forged" as never, clause));
  }
});

test("Action live authority runs unchanged policies through snapshot-scoped SQL", async () => {
  let allowed = true;
  const f = await fixture({
    inputPolicy() {
      if (!allowed) throw new Error("input denied");
    },
  });
  try {
    await f.port().claim(f.hint(), {});
    await assert.rejects(
      f.db.withReadSnapshot!((scope) =>
        f.execution.authorizeLive(scope.snapshot, f.caller(), f.state.time)
      ),
      /read-only/i,
    );
    await f.db.withReadSnapshot!(async (scope) => {
      const run = async (
        tx: SqlExecutor,
        mode: "locking" | "exclusive-read",
      ) => {
        const live = await f.execution.authorizeLive(
          tx,
          f.caller(),
          f.state.time,
          mode,
        );
        assert.equal(live.deliveryId, f.reference().deliveryId);
        allowed = false;
        await assert.rejects(
          f.execution.authorizeLive(tx, f.caller(), f.state.time, mode),
          /input denied/,
        );
      };
      if (scope.kind === "exclusive") {
        await run(scope.snapshot, "exclusive-read");
      } else await scope.current((tx) => run(tx, "locking"));
    });
  } finally {
    await f.close();
  }
});

test("worker Processor snapshot authority keeps current ctx grant checks", async () => {
  const f = await processorFixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.db.withReadSnapshot!(async (scope) => {
      const run = async (
        tx: SqlExecutor,
        mode: "locking" | "exclusive-read",
      ) => {
        const live = await f.processorCommands.authorizeLive(
          tx,
          f.caller(),
          f.state.time,
          mode,
        );
        assert.equal(live.delivery.id, f.source.deliveryId);
        f.state.ctx = false;
        await assert.rejects(
          f.processorCommands.authorizeLive(tx, f.caller(), f.state.time, mode),
        );
      };
      if (scope.kind === "exclusive") {
        await run(scope.snapshot, "exclusive-read");
      } else await scope.current((tx) => run(tx, "locking"));
    });
  } finally {
    await f.close();
  }
});
