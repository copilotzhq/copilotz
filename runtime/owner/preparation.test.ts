/** Actual current-table preparation capture, child admission and input gates. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerClaimKey } from "../execution/owner-port.ts";
import {
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  ownerChildActionKey,
  type OwnerChildActionReference,
} from "../execution/child-action-port.ts";
import type { OwnerJson } from "./boundary.ts";
import { OWNER_CHILD_ACTION_PREPARATION } from "./preparation.ts";
import { preparationCaptureFromMetadata } from "./preparation-capture.ts";
import { fixture, namespace, ownerId } from "./preparation.fixture.test.ts";

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

test("named preparation rejects missing or mismatched target before fresh and duplicate access", async () => {
  const f = await fixture();
  try {
    const original = f.request();
    const { targetActionId: _target, ...missing } = original.input;
    for (const duplicate of [false, true]) {
      if (duplicate) {
        await f.prepare();
        const deadline = Date.now() + 1_000;
        while (!f.state.scheduled.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(f.state.scheduled.length, 1);
      }
      const counts = [
        f.state.rendered,
        f.state.projected,
        f.state.resourceProjected,
        f.state.mapped,
        f.state.scheduled.length,
      ];
      for (
        const input of [missing, {
          ...original.input,
          targetActionId: "fixture.other",
        }]
      ) {
        await assert.rejects(
          f.boundary.executeInput(f.caller(), { ...original, input }),
          /preparation_/,
        );
      }
      assert.deepEqual([
        f.state.rendered,
        f.state.projected,
        f.state.resourceProjected,
        f.state.mapped,
        f.state.scheduled.length,
      ], counts);
      assert.equal(
        (await f.db.query(
          "SELECT key FROM owner_receipts WHERE kind='action.child-prepare'",
        )).rows.length,
        duplicate ? 1 : 0,
      );
    }
    assert.equal((await f.prepare()).status, "duplicate");
    assert.equal(f.state.rendered, 1);
  } finally {
    await f.close();
  }
});

test("named preparation refuses mapper-generated protected families before child capture", async () => {
  const f = await fixture({
    mapInput(text) {
      return {
        text,
        unsupported: { schema: "copilotz.action.lifecycle.protected.v2" },
      };
    },
  });
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
    await assert.rejects(f.prepare(), /preparation_unsupported/);
    assert.deepEqual(await counts(), before);
    assert.equal(f.state.rendered, 1);
    assert.equal(f.state.mapped, 1);
    assert.equal(f.state.scheduled.length, 0);
  } finally {
    await f.close();
  }
});

for (
  const stage of [
    "duplicate-read",
    "receipt-insert",
    "reader-insert",
    "savepoint",
    "commit-reply",
  ] as const
) {
  test(`prepared admission fences private parent loss after ${stage}`, async () => {
    const f = await fixture();
    try {
      if (stage === "duplicate-read") await f.prepare();
      const snapshot = async () => {
        const tables = (await f.db.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
        )).rows;
        const result: Record<string, unknown> = {};
        for (const { table_name } of tables) {
          const name = `"${table_name.replaceAll('"', '""')}"`;
          result[table_name] = (await f.db.query(
            `SELECT row_to_json(t) AS data FROM ${name} t ORDER BY row_to_json(t)::text`,
          )).rows;
        }
        return result;
      };
      const before = await snapshot();
      const scheduled = structuredClone(f.state.scheduled);
      let reached = false, reads = 0;
      const lose = () => {
        reached = true;
        f.state.live = false;
      };
      f.state.afterQuery = (sql) => {
        if (
          stage === "duplicate-read" &&
          sql.includes("SELECT kind,intent,result") && ++reads === 2
        ) lose();
        if (
          stage === "receipt-insert" && /INSERT INTO .*owner_receipts/.test(sql)
        ) lose();
        if (
          stage === "reader-insert" &&
          /INSERT INTO .*owner_receipt_readers/.test(sql)
        ) lose();
        if (stage === "savepoint" && sql.startsWith("RELEASE SAVEPOINT")) {
          lose();
        }
      };
      if (stage === "commit-reply") f.state.afterTransaction = lose;
      await assert.rejects(
        f.prepare(),
        (error: unknown) =>
          (error as { code?: string }).code ===
            (stage === "savepoint"
              ? "ActionOwnershipLost"
              : "owner_authorization_lost"),
      );
      assert.equal(reached, true);
      assert.equal(f.state.ctx, true);
      assert.equal(f.state.originalAllowed, true);
      if (stage !== "commit-reply") {
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(f.state.scheduled, scheduled);
      } else {
        assert.equal(
          (await f.db.query(
            "SELECT id FROM events WHERE type='copilotz.owner.action.requested'",
          )).rows.length,
          2,
        );
        const receipts =
          (await f.db.query<{ result: OwnerChildActionReference }>(
            "SELECT result FROM owner_receipts WHERE owner=$1 AND domain='logical' AND key=$2 AND kind=$3",
            [ownerId, f.request().key, OWNER_CHILD_ACTION_PREPARATION],
          )).rows;
        assert.equal(receipts.length, 1);
        const readers = (await f.db.query(
          "SELECT principal_kind,principal_id FROM owner_receipt_readers WHERE owner=$1 AND domain='logical' AND key=$2",
          [ownerId, f.request().key],
        )).rows;
        assert.deepEqual(readers, [{
          principal_kind: "worker",
          principal_id: JSON.stringify([f.parent.workerId]),
        }]);
        assert.deepEqual(f.state.scheduled, [...scheduled, receipts[0].result]);
        assert.equal(f.state.rendered, 1);
        assert.equal(f.state.mapped, 1);
      }
    } finally {
      await f.close();
    }
  });
}
