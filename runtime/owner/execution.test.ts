import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import type { OwnerCommand } from "./boundary.ts";
import {
  at,
  fixture,
  snapshot,
  start,
  within,
} from "./execution.fixture.test.ts";

test("registered Action claims real delivery, uses owner Collection plan, completes lifecycle and safe replay", async () => {
  const f = await fixture();
  try {
    const worker = f.worker();
    const result = await worker.execute(f.hint());
    assert.equal(result.status, "executed");
    if (result.status === "executed") {
      assert.deepEqual(result.completion, {
        status: "completed",
        output: { id: "note", message: "hello world!" },
      });
    }
    await within(f.observed.promise);
    assert.deepEqual(f.state.observations, [1]);
    assert.equal(f.state.executions, 1);
    assert.equal(f.state.persistenceOpens, 0);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "succeeded",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
    const terminal = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "run:action:terminal",
    );
    assert.equal(terminal?.status, "completed");
    const receipt = await f.port().readCompletion(f.reference(), {});
    assert.deepEqual(receipt, { ...f.reference(), status: "completed" });
    assert.equal(JSON.stringify(receipt).includes("world"), false);
    const projections = f.state.projections;
    await f.set("ctx_granted", false);
    assert.equal((await worker.execute(f.hint())).status, "replayed");
    assert.equal((await f.worker().execute(f.hint())).status, "replayed");
    assert.equal(f.state.projections, projections);
    assert.equal(f.state.executions, 1);
    await assert.rejects(f.port().project(f.reference(), {}), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("claim input and terminal caller output remain behind outer commit", async () => {
  for (const kind of ["execution.claim", "execution.complete"]) {
    const f = await fixture();
    try {
      f.state.gateKind = kind;
      let exposed = false;
      const pending = f.worker().execute(f.hint()).then((value) => {
        exposed = true;
        return value;
      });
      await within(f.gate.reached.promise);
      assert.equal(exposed, false);
      if (kind === "execution.claim") {
        assert.equal(f.state.executions, 0);
        assert.deepEqual(f.state.publications, []);
      } else {
        assert.equal(f.state.executions, 1);
        assert.equal(
          f.state.publications.includes("fixture.work.completed"),
          false,
        );
      }
      f.gate.release.resolve();
      assert.equal((await within(pending)).status, "executed");
    } finally {
      await f.close();
    }
  }
});

test("claim and completion rollback lifecycle, delivery, sequence and receipt together", async () => {
  for (const kind of ["claim", "complete"]) {
    const f = await fixture();
    try {
      if (kind === "complete") await f.port().claim(f.hint(), {});
      const before = await snapshot(f.db);
      const count = f.state.publications.length;
      f.state.rollback = true;
      await assert.rejects(
        kind === "claim"
          ? f.freshPort().claim(f.hint(), {})
          : f.port().complete(f.reference(), {
            status: "completed",
            output: { id: "n", message: "x" },
          }, {}),
        /injected command rollback/,
      );
      assert.notDeepEqual(f.state.rollbackSnapshot, before);
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.publications.length, count);
      assert.equal(
        (await (kind === "claim"
          ? f.freshPort().claim(f.hint(), {})
          : f.port().complete(f.reference(), {
            status: "completed",
            output: { id: "n", message: "x" },
          }, {}))).status,
        "committed",
      );
    } finally {
      await f.close();
    }
  }
});

test("revoked input projection and general mutation do not revoke narrow live settlement authority", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.set("input_granted", false);
    await assert.rejects(
      f.port().project(f.reference(), {}),
      /input authorization revoked/,
    );
    await f.set("ctx_granted", false);
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(
      f.port().execute({
        kind: "collections",
        domain: "logical",
        key: "root/work/write",
        intent: { operations: [] },
      }),
      { code: "ActionOwnershipLost" },
    );
    const result = await f.port().complete(f.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    assert.equal(result.result.status, "failed");
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "dead_letter",
    );
  } finally {
    await f.close();
  }
});

test("lost completion reply recovers references after settlement without rerunning business code", async () => {
  const f = await fixture();
  try {
    f.state.lostCompletion = true;
    await assert.rejects(
      f.worker().execute(f.hint()),
      /lost committed completion reply/,
    );
    await f.set("ctx_granted", false);
    const recovered = await f.worker().execute(f.hint());
    assert.equal(recovered.status, "replayed");
    assert.equal(f.state.executions, 1);
    assert.deepEqual(await f.port().readCompletion(f.reference(), {}), {
      ...f.reference(),
      status: "completed",
    });
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("expiry, replacement assignment and stale epoch cannot hydrate or settle", async () => {
  const f = await fixture();
  try {
    const oldCaller = f.caller();
    const oldPort = f.port(oldCaller);
    const oldRef = f.reference();
    await oldPort.claim(f.hint(), {});
    f.state.time = at(1000);
    await assert.rejects(oldPort.project(oldRef, {}), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(
      oldPort.complete(oldRef, { status: "failed", code: "action_failed" }, {}),
      { code: "ActionOwnershipLost" },
    );
    await f.replace();
    f.state.time = at(1001);
    await f.port().claim(f.hint(), {});
    assert.equal((await f.store.getDelivery(oldRef.deliveryId))?.attempts, 2);
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    await assert.rejects(
      oldPort.complete(oldRef, { status: "failed", code: "action_failed" }, {}),
      { code: "ActionOwnershipLost" },
    );
    await assert.rejects(
      f.boundary.execute(
        { ...f.caller(), ownerEpoch: 0 },
        f.completeCommand({ status: "cancelled", code: "action_cancelled" }),
      ),
      { code: "ActionOwnershipLost" },
    );
    await f.port().complete(f.reference(), {
      status: "cancelled",
      code: "action_cancelled",
    }, {});
    const prior = await snapshot(f.db);
    await assert.rejects(oldPort.project(oldRef, {}), {
      code: "ActionOwnershipLost",
    });
    assert.deepEqual(await snapshot(f.db), prior);
  } finally {
    await f.close();
  }
});

test("current scope cancellation takes precedence over success and failure, with one cancellation terminal", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
      [start, f.source.event.id],
    );
    const before = await snapshot(f.db);
    for (
      const completion of [{
        status: "completed",
        output: { id: "n", message: "x" },
      }, { status: "failed", code: "action_failed" }] as const
    ) {
      await assert.rejects(f.port().complete(f.reference(), completion, {}), {
        code: "ActionOwnershipLost",
      });
    }
    await assert.rejects(f.port().project(f.reference(), {}), {
      code: "ActionOwnershipLost",
    });
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(
      (await f.port().complete(f.reference(), {
        status: "cancelled",
        code: "action_cancelled",
      }, {})).result.status,
      "cancelled",
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "cancelled",
    );
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("competing terminal commands share one logical identity; settled replay is read-only recovery", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    const outcomes = await Promise.allSettled([
      f.port().complete(f.reference(), {
        status: "completed",
        output: { id: "n", message: "x" },
      }, {}),
      f.port().complete(f.reference(), {
        status: "failed",
        code: "action_failed",
      }, {}),
      f.port().complete(f.reference(), {
        status: "cancelled",
        code: "action_cancelled",
      }, {}),
    ]);
    assert.deepEqual(outcomes.map((item) => item.status), [
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query(
        "SELECT key FROM owner_receipts WHERE kind='execution.complete'",
      )).rows.length,
      1,
    );
    await assert.rejects(
      f.port().complete(f.reference(), {
        status: "completed",
        output: { id: "n", message: "x" },
      }, {}),
      { code: "ActionOwnershipLost" },
    );
    assert.equal(
      (await f.port().readCompletion(f.reference(), {}))?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("command keys, namespace and invocation are reauthorized on duplicate claims", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    assert.equal(
      (await f.boundary.execute(f.caller(), f.claimCommand())).status,
      "duplicate",
    );
    for (
      const command of [
        { ...f.claimCommand(), key: "forged" },
        {
          ...f.claimCommand(),
          intent: { assignmentId: "other", sessionId: "session" },
        },
        {
          ...f.completeCommand({ status: "failed", code: "action_failed" }),
          key: "status:failed",
        },
        {
          ...f.completeCommand({ status: "failed", code: "action_failed" }),
          intent: {
            namespace: "other",
            executionId: "run",
            completion: { status: "failed", code: "action_failed" },
          },
        },
      ]
    ) {
      await assert.rejects(
        f.boundary.execute(f.caller(), command as OwnerCommand),
        { code: "ActionOwnershipLost" },
      );
    }
    await f.set("ctx_granted", false);
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("different-worker settled recovery cannot grant hydration or business reexecution", async () => {
  const f = await fixture();
  try {
    await f.worker().execute(f.hint());
    const originalRef = f.reference();
    await f.replace({ workerId: "replacement-worker" });
    assert.equal(await f.port().readCompletion(originalRef, {}), undefined);
    await assert.rejects(f.worker().execute(f.hint()), {
      code: "ActionOwnershipLost",
    });
    assert.equal(f.state.executions, 1);
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("inline input, protected, content and deferred Actions refuse before claim or hydration", async () => {
  const definitions: { action?: AnyActionDefinition; inline?: boolean }[] = [
    { inline: true },
    {
      action: defineAction({
        id: "secret",
        inputSchema: { type: "string", "x-copilotz-secret": true } as never,
        execute: () => null,
      }),
    },
    {
      action: {
        id: "content",
        content: { input: ["body"] },
        execute: () => null,
      },
    },
    {
      action: {
        id: "deferred",
        execute: () => null,
        resolve: () => null,
      } as AnyActionDefinition,
    },
  ];
  for (const input of definitions) {
    const f = await fixture(input);
    try {
      const before = await snapshot(f.db);
      await assert.rejects(f.port().claim(f.hint(), {}));
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.executions, 0);
      assert.equal(f.state.projections, 0);
    } finally {
      await f.close();
    }
  }
});

test("forged provider details and inconsistent failure codes cannot enter terminal lifecycle", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    const before = await snapshot(f.db);
    for (
      const completion of [
        { status: "failed", code: "private_provider_token" },
        { status: "failed", code: "action_cancelled" },
        { status: "cancelled", code: "action_failed" },
      ] as const
    ) {
      await assert.rejects(
        f.port().complete(f.reference(), completion, {}),
        /Invalid safe execution failure code/,
      );
    }
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(
      (await f.port().complete(f.reference(), {
        status: "failed",
        code: "action_capability_unsupported",
      }, {})).result.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("captured invoked input survives source changes and current replacement reads only that capture", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.db.query(
      "UPDATE event_bodies SET body=$1::jsonb WHERE event_body_id='source-input'",
      [JSON.stringify("changed")],
    );
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    f.state.time = at(1001);
    await f.replace();
    await f.port().claim(f.hint(), {});
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:invoked'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("lost parent assignment or settlement grant blocks restricted completion after ctx revocation", async () => {
  for (const column of ["settlement_granted", "live"] as const) {
    const f = await fixture();
    try {
      await f.port().claim(f.hint(), {});
      await f.set("ctx_granted", false);
      await f.set(column, false);
      const before = await snapshot(f.db);
      await assert.rejects(
        f.port().complete(f.reference(), {
          status: "cancelled",
          code: "action_cancelled",
        }, {}),
        { code: "ActionOwnershipLost" },
      );
      assert.deepEqual(await snapshot(f.db), before);
    } finally {
      await f.close();
    }
  }
});

test("unknown outer claim or completion rolls back all effects and stops the owner without output", async () => {
  for (const terminal of [false, true]) {
    const f = await fixture();
    try {
      if (terminal) await f.port().claim(f.hint(), {});
      const before = await snapshot(f.db);
      const publications = f.state.publications.length;
      f.state.rejectOuter = true;
      // Direct command avoids the separate recovery-read transaction consuming
      // this deliberately injected outer-command failure.
      await assert.rejects(
        f.boundary.execute(
          f.caller(),
          terminal
            ? f.completeCommand({ status: "failed", code: "action_failed" })
            : f.claimCommand(),
        ),
        { code: "owner_commit_unknown" },
      );
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.publications.length, publications);
      assert.equal(f.boundary.state, "stopped");
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});
