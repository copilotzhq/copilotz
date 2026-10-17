import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerEffectCommands } from "./effects.ts";
import { createOwnerEffectClient, ownerEffectKey } from "./effects-client.ts";

const scope = { namespace: "space", actionRunId: "run" };
const ref = { ...scope, step: "send" };
const evidence = { source: "dispatch", reference: "host-proof" };
const safeOutcome = { messageId: "provider-1" };
const caller = (epoch = 1): OwnerCaller => ({
  workerId: "worker-1",
  ownerEpoch: epoch,
  sessionId: "connection-1",
  assignmentId: "assignment-1",
  dispatchAttemptId: "attempt-1",
});
const command = (
  operation: "begin" | "confirm" | "notStarted",
  extra = {},
): OwnerCommand => ({
  kind: `effect.${operation}`,
  domain: "logical",
  key: ownerEffectKey("owner", ref, operation),
  intent: { ...ref, ...extra },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await db.query(`CREATE TABLE effect_test_authority (
    worker_id text, session_id text, attempt_id text, begin_granted boolean,
    settlement_granted boolean, proof text, proof_step text)`);
  await db.query(
    "INSERT INTO effect_test_authority VALUES ('worker-1','connection-1','attempt-1',true,true,'host-proof','send')",
  );
  const state = {
    rollback: false,
    authorityReturnsTrue: true,
    outcomeReturnsTrue: true,
    evidenceReturnsTrue: true,
    unknownCommit: false,
    loseBeginReply: false,
    gate: false,
    reached: deferred(),
    release: deferred(),
    who: caller(),
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(operation) {
      const result = await db.transaction(async (tx) => {
        const value = await operation({
          async query(sql, params) {
            if (state.rollback && sql === "RELEASE SAVEPOINT owner_command_0") {
              state.rollback = false;
              throw new Error("injected effect rollback");
            }
            return await tx.query(sql, params);
          },
        });
        if (state.gate) {
          state.gate = false;
          state.reached.resolve();
          await state.release.promise;
        }
        return value;
      });
      if (state.unknownCommit) {
        state.unknownCommit = false;
        throw Object.assign(new Error("lost COMMIT response"), {
          outcome: "unknown",
        });
      }
      return result;
    },
  };
  const effects = createOwnerEffectCommands({
    ownerId: "owner",
    schema: "public",
    async authorizeEffect(tx, who, target, mode) {
      const row = (await tx.query<Record<string, unknown>>(
        "SELECT * FROM effect_test_authority",
      )).rows[0];
      assert.equal(target.namespace, scope.namespace, "wrong namespace");
      assert.equal(target.actionRunId, scope.actionRunId, "wrong invocation");
      if (
        who.workerId !== row.worker_id || who.sessionId !== row.session_id ||
        who.dispatchAttemptId !== row.attempt_id ||
        who.assignmentId !== "assignment-1" ||
        !(mode === "begin" ? row.begin_granted : row.settlement_granted)
      ) {
        throw Object.assign(new Error("current effect authority refused"), {
          code: "ActionOwnershipLost",
        });
      }
      return state.authorityReturnsTrue;
    },
    validateOutcome(_tx, _who, _target, value) {
      assert.equal(
        typeof value,
        "object",
        "registered public outcome required",
      );
      assert.deepEqual(
        Object.keys(value!),
        ["messageId"],
        "only registered public outcome is allowed",
      );
      assert.match(
        String((value as { messageId: unknown }).messageId),
        /^provider-[0-9]+$/,
      );
      return state.outcomeReturnsTrue;
    },
    async verifyNotStarted(tx, _who, target, value) {
      const row = (await tx.query<{ proof: string; proof_step: string }>(
        "SELECT proof,proof_step FROM effect_test_authority",
      )).rows[0];
      if (
        value.source !== "dispatch" || value.reference !== row.proof ||
        target.step !== row.proof_step
      ) {
        throw new Error("no owner-verified no-start evidence");
      }
      return state.evidenceReturnsTrue;
    },
  });
  const makeBoundary = (holderId: string) =>
    createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId,
      handlers: effects.handlers,
      projections: effects.projections,
      authorize: effects.authorize,
      authenticateReceipt(_tx, who) {
        assert.equal(who.workerId, "worker-1");
      },
    });
  let boundary = makeBoundary("holder-1");
  await boundary.acquire(0);
  const client = () =>
    createOwnerEffectClient({
      ownerId: "owner",
      ...scope,
      port: {
        async execute(input, options) {
          const value = await boundary.execute(state.who, input, options);
          if (state.loseBeginReply) {
            state.loseBeginReply = false;
            throw Object.assign(new Error("lost begin reply"), {
              execution: "indeterminate",
            });
          }
          return value;
        },
        settle: (input, options) => boundary.execute(state.who, input, options),
        project: (kind, input, options) =>
          boundary.project(state.who, kind, input, options),
      },
    });
  return {
    db,
    state,
    effects,
    client,
    get boundary() {
      return boundary;
    },
    async takeover() {
      const old = boundary;
      boundary = makeBoundary("holder-2");
      await boundary.acquire(old.epoch!);
      state.who = caller(boundary.epoch!);
      return old;
    },
    async close() {
      state.release.resolve();
      boundary.stop();
      await db.close();
    },
  };
}

test("effect begin issues one live proceed and durable duplicates never repeat permission", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.client().begin("send"), { status: "proceed" });
    assert.deepEqual(await f.client().begin("send"), {
      status: "indeterminate",
    });
    const receipt = await f.boundary.readReceipt(caller(), {
      domain: "logical",
      key: command("begin").key,
    });
    assert.deepEqual(receipt?.result, { ...ref, status: "begun" });
    assert.equal(JSON.stringify(receipt).includes("proceed"), false);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("effect no-start requires exact owner evidence; worker assertions cannot reopen a step", async () => {
  const f = await fixture();
  try {
    await f.client().begin("send");
    for (
      const proof of [{ source: "dispatch", reference: "forged" }, {
        ...evidence,
        notStarted: true,
      }]
    ) {
      await assert.rejects(
        f.client().notStarted("send", proof),
        /evidence|effect/i,
      );
    }
    assert.deepEqual(await f.client().inspect("send"), {
      status: "indeterminate",
    });
    await f.client().notStarted("send", evidence);
    assert.deepEqual(await f.client().begin("send"), { status: "not_started" });
    assert.deepEqual(await f.client().begin("send-2"), { status: "proceed" });
    await assert.rejects(f.client().confirm("send", safeOutcome), {
      code: "effect_transition_conflict",
    });
  } finally {
    await f.close();
  }
});

test("effect confirmation replays across attempts while incompatible and closed transitions refuse", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client().confirm("send", safeOutcome), {
      code: "effect_transition_conflict",
    });
    await f.client().begin("send");
    await f.client().confirm("send", safeOutcome);
    await f.client().confirm("send", safeOutcome);
    await assert.rejects(
      f.client().confirm("send", { messageId: "provider-2" }),
      { code: "owner_intent_conflict" },
    );
    await assert.rejects(f.client().notStarted("send", evidence), {
      code: "effect_transition_conflict",
    });
    assert.deepEqual(await f.client().begin("send"), {
      status: "replay",
      outcome: safeOutcome,
    });
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("concurrent begin gets one proceed and confirm versus no-start has one terminal winner", async () => {
  const f = await fixture();
  try {
    const begins = await Promise.all([
      f.client().begin("send"),
      f.client().begin("send"),
    ]);
    assert.deepEqual(begins.map((value) => value.status).sort(), [
      "indeterminate",
      "proceed",
    ]);
    const results = await Promise.allSettled([
      f.client().confirm("send", safeOutcome),
      f.client().notStarted("send", evidence),
    ]);
    assert.deepEqual(results.map((value) => value.status), [
      "fulfilled",
      "rejected",
    ]);
    assert.deepEqual(await f.client().inspect("send"), {
      status: "replay",
      outcome: safeOutcome,
    });
  } finally {
    await f.close();
  }
});

test("effect permission is gated by outer commit and cancellation after commit cannot publish proceed", async () => {
  const f = await fixture();
  try {
    f.state.gate = true;
    const controller = new AbortController();
    let exposed = false;
    const pending = f.client().begin("send", { signal: controller.signal })
      .then((value) => {
        exposed = true;
        return value;
      });
    pending.catch(() => {});
    await f.state.reached.promise;
    assert.equal(exposed, false);
    controller.abort(new Error("cancel after command prepared"));
    f.state.release.resolve();
    await assert.rejects(pending, /cancel after command prepared/);
    assert.equal(exposed, false);
    assert.deepEqual(await f.client().inspect("send"), {
      status: "indeterminate",
    });
  } finally {
    await f.close();
  }
});

test("known savepoint rollback leaves no effect or permission and permits a fresh begin", async () => {
  const f = await fixture();
  try {
    f.state.rollback = true;
    await assert.rejects(f.client().begin("send"), /injected effect rollback/);
    assert.deepEqual(await f.client().inspect("send"), { status: "none" });
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      0,
    );
    assert.deepEqual(await f.client().begin("send"), { status: "proceed" });
  } finally {
    await f.close();
  }
});

test("lost begin response is not retried and same-worker receipt recovery grants no send", async () => {
  const f = await fixture();
  try {
    f.state.loseBeginReply = true;
    await assert.rejects(f.client().begin("send"), /lost begin reply/);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      1,
    );
    assert.deepEqual(await f.client().inspect("send"), {
      status: "indeterminate",
    });
    assert.deepEqual(await f.client().begin("send"), {
      status: "indeterminate",
    });
  } finally {
    await f.close();
  }
});

test("unknown outer commit stops owner; takeover sees begun or confirmed without resending", async () => {
  for (const stage of ["begin", "confirm"] as const) {
    const f = await fixture();
    try {
      if (stage === "confirm") await f.client().begin("send");
      f.state.unknownCommit = true;
      await assert.rejects(
        stage === "begin"
          ? f.client().begin("send")
          : f.client().confirm("send", safeOutcome),
        { code: "owner_commit_unknown" },
      );
      assert.equal(f.boundary.state, "stopped");
      await f.takeover();
      assert.deepEqual(
        await f.client().begin("send"),
        stage === "begin"
          ? { status: "indeterminate" }
          : { status: "replay", outcome: safeOutcome },
      );
    } finally {
      await f.close();
    }
  }
});

test("current settlement survives ctx revocation while stale epochs and attempts remain fenced", async () => {
  const f = await fixture();
  try {
    await f.client().begin("send");
    await f.db.query("UPDATE effect_test_authority SET begin_granted=false");
    await assert.rejects(f.client().begin("send-2"), {
      code: "ActionOwnershipLost",
    });
    assert.equal(f.boundary.state, "acquired");
    await f.client().confirm("send", safeOutcome);
    assert.deepEqual(await f.client().inspect("send"), {
      status: "replay",
      outcome: safeOutcome,
    });
    await f.takeover();
    await assert.rejects(
      f.boundary.execute(
        caller(),
        command("confirm", { outcome: safeOutcome }),
      ),
      { code: "ActionOwnershipLost" },
    );
  } finally {
    await f.close();
  }
});

test("a current replacement worker replays the same logical effect without receiving first-send permission", async () => {
  const f = await fixture();
  try {
    await f.client().begin("send");
    await f.db.query(
      "UPDATE effect_test_authority SET worker_id='worker-2',session_id='connection-2',attempt_id='attempt-2'",
    );
    f.state.who = {
      ...caller(),
      workerId: "worker-2",
      sessionId: "connection-2",
      dispatchAttemptId: "attempt-2",
    };
    assert.deepEqual(await f.client().begin("send"), {
      status: "indeterminate",
    });
    await f.client().confirm("send", safeOutcome);
    assert.deepEqual(await f.client().inspect("send"), {
      status: "replay",
      outcome: safeOutcome,
    });
    await assert.rejects(f.boundary.project(caller(), "effect.state", ref), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("effect key, kind, domain and invocation are checked before any durable command", async () => {
  const f = await fixture();
  try {
    for (
      const input of [
        { ...command("begin"), key: "foreign" },
        { ...command("begin"), domain: "incarnation" as const },
        { ...command("begin"), kind: "effect.unknown" },
        { ...command("begin"), intent: { ...ref, extra: true } },
        { ...command("begin"), intent: { ...ref, actionRunId: "other" } },
      ]
    ) await assert.rejects(f.boundary.execute(caller(), input));
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      0,
    );
    const foreign = { ...ref, namespace: "other" };
    await assert.rejects(
      f.boundary.execute(caller(), {
        kind: "effect.begin",
        domain: "logical",
        key: ownerEffectKey("owner", foreign, "begin"),
        intent: foreign,
      }),
      /wrong namespace/,
    );
  } finally {
    await f.close();
  }
});

test("effect outcomes require registered safe validation and no-start evidence is bound to its exact step", async () => {
  const f = await fixture();
  try {
    await f.client().begin("send");
    await assert.rejects(
      f.client().confirm("send", {
        messageId: "provider-1",
        secret: "plaintext",
      }),
      /registered public outcome/,
    );
    await f.client().begin("another-send");
    await assert.rejects(
      f.client().notStarted("another-send", evidence),
      /no owner-verified/,
    );
    assert.deepEqual(await f.client().inspect("send"), {
      status: "indeterminate",
    });
    assert.deepEqual(await f.client().inspect("another-send"), {
      status: "indeterminate",
    });
    assert.equal(
      JSON.stringify((await f.db.query("SELECT * FROM owner_receipts")).rows)
        .includes("plaintext"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("missing or false authority, outcome and evidence validators fail closed", async () => {
  assert.throws(
    () =>
      createOwnerEffectCommands(
        { ownerId: "owner", schema: "public" } as never,
      ),
    /authorizeEffect is required/,
  );
  const f = await fixture();
  try {
    f.state.authorityReturnsTrue = false;
    await assert.rejects(f.client().begin("send"), {
      code: "effect_authority_refused",
    });
    f.state.authorityReturnsTrue = true;
    await f.client().begin("send");
    f.state.outcomeReturnsTrue = false;
    await assert.rejects(f.client().confirm("send", safeOutcome), {
      code: "effect_outcome_invalid",
    });
    f.state.evidenceReturnsTrue = false;
    await assert.rejects(f.client().notStarted("send", evidence), {
      code: "effect_evidence_refused",
    });
    assert.deepEqual(await f.client().inspect("send"), {
      status: "indeterminate",
    });
    f.state.authorityReturnsTrue = false;
    await assert.rejects(f.client().inspect("send"), {
      code: "effect_authority_refused",
    });
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("owner enforces the inventory step bound before a fresh begin but permits existing recovery", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(await f.client().begin(`step-${index}`), {
        status: "proceed",
      });
    }
    await assert.rejects(f.client().begin("overflow"), {
      code: "effect_step_limit",
    });
    assert.deepEqual(await f.client().begin("step-0"), {
      status: "indeterminate",
    });
    await f.client().confirm("step-0", safeOutcome);
    assert.deepEqual(await f.client().begin("step-0"), {
      status: "replay",
      outcome: safeOutcome,
    });
    assert.equal(
      (await f.db.query(
        "SELECT key FROM owner_receipts WHERE kind='effect.begin'",
      )).rows.length,
      100,
    );
  } finally {
    await f.close();
  }
});
