import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlExecutor } from "../events/session.ts";
import type { EventDelivery } from "../events/types.ts";
import type { OwnerLocalAssignmentBinding } from "./assignments.ts";
import {
  assertOwnerAttemptCaller,
  type OwnerAttemptAuthority,
  ownerAttemptIsLive,
  ownerAttemptToken,
  ownerEventCommitForAttempt,
  type OwnerWorkerAttemptAuthority,
} from "./attempt-authority.ts";
import type { OwnerCaller, OwnerCommandContext } from "./boundary.ts";

const now = "2026-10-17T05:00:00.000Z";
const past = "2026-10-17T04:59:59.999Z";
const future = "2026-10-17T05:00:00.001Z";
const worker = (): OwnerWorkerAttemptAuthority => ({
  placement: "worker",
  ownerId: "owner",
  workerId: "worker",
  sessionId: "session",
  assignmentId: "assignment",
  dispatchAttemptId: "dispatch",
  deliveryId: "delivery",
});
const local = (): OwnerLocalAssignmentBinding => ({
  placement: "owner-local",
  kind: "action",
  ownerId: "owner",
  epoch: 7,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "event",
  deliveryId: "delivery",
  actionId: "action",
  actionRunId: "run",
});
const processor = (): OwnerLocalAssignmentBinding => ({
  placement: "owner-local",
  kind: "processor",
  ownerId: "owner",
  epoch: 7,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "event",
  deliveryId: "delivery",
  processorId: "processor",
  consumerId: "processor:processor",
});
const workerCaller = (): OwnerCaller => ({
  principal: { kind: "worker", workerId: "worker" },
  ownerEpoch: 7,
  sessionId: "session",
  assignmentId: "assignment",
  dispatchAttemptId: "dispatch",
});
const localCaller = (): OwnerCaller => ({
  principal: {
    kind: "owner-local",
    ownerId: "owner",
    epoch: 7,
    holderId: "holder",
    deliveryId: "delivery",
    attemptId: "attempt",
  },
  ownerEpoch: 7,
});
const controlCaller = (): OwnerCaller => ({
  principal: {
    kind: "owner-control",
    ownerId: "owner",
    epoch: 7,
    holderId: "holder",
  },
  ownerEpoch: 7,
});
const delivery = (changes = {}): EventDelivery => ({
  databaseSchema: "public",
  id: "delivery",
  eventId: "event",
  consumerId: "consumer",
  settlementScopeId: "scope",
  status: "leased",
  attempts: 1,
  maxAttempts: 3,
  availableAt: now,
  leaseOwner: "dispatch",
  leaseExpiresAt: future,
  createdAt: now,
  updatedAt: now,
  ...changes,
});
const tx: SqlExecutor = {
  query() {
    throw new Error("Pure authority helpers must never execute SQL.");
  },
};
const afterCommit = () => {
  throw new Error("Pure authority helpers must never schedule callbacks.");
};
const context = (): OwnerCommandContext => ({
  tx,
  caller: localCaller(),
  command: { kind: "execution.complete", domain: "logical", key: "key" },
  commandTime: now,
  signal: new AbortController().signal,
  ownerCommit: {
    transaction: tx,
    ownerId: "owner",
    epoch: 7,
    holderId: "holder",
    commandTime: now,
  },
  afterCommit,
});
function asAuthority(value: unknown) {
  return value as OwnerAttemptAuthority;
}
function asCaller(value: unknown) {
  return value as OwnerCaller;
}
function asContext(value: unknown) {
  return value as OwnerCommandContext;
}
function without(value: object, key: string) {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}
const ownershipLost = { code: "ActionOwnershipLost" };

test("attempt caller matching accepts exact authenticated worker and local tuples", () => {
  assertOwnerAttemptCaller(workerCaller(), worker(), "owner");
  assertOwnerAttemptCaller(localCaller(), local(), "owner");
  assertOwnerAttemptCaller(localCaller(), processor(), "owner");
  // The worker coordinate subset has no epoch; its fence remains the boundary's
  // responsibility, rather than being invented here from another field.
  assertOwnerAttemptCaller(
    { ...workerCaller(), ownerEpoch: 8 },
    worker(),
    "owner",
  );
});

test("worker caller matching rejects every mismatched identity coordinate", () => {
  for (
    const key of [
      "ownerId",
      "workerId",
      "sessionId",
      "assignmentId",
      "dispatchAttemptId",
    ]
  ) {
    assert.throws(
      () =>
        assertOwnerAttemptCaller(workerCaller(), {
          ...worker(),
          [key]: "other",
        }, "owner"),
      ownershipLost,
      key,
    );
  }
  assert.throws(
    () => assertOwnerAttemptCaller(workerCaller(), worker(), "other"),
    ownershipLost,
  );
  for (const key of ["sessionId", "assignmentId", "dispatchAttemptId"]) {
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          { ...workerCaller(), [key]: "other" },
          worker(),
          "owner",
        ),
      ownershipLost,
      key,
    );
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          asCaller(without(workerCaller(), key)),
          worker(),
          "owner",
        ),
      TypeError,
      key,
    );
  }
});

test("local caller matching rejects every mismatched principal coordinate and outer epoch", () => {
  for (
    const key of ["ownerId", "epoch", "holderId", "deliveryId", "attemptId"]
  ) {
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          asCaller({
            ...localCaller(),
            principal: {
              ...localCaller().principal,
              [key]: key === "epoch" ? 8 : "other",
            },
          }),
          local(),
          "owner",
        ),
      ownershipLost,
      key,
    );
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          localCaller(),
          asAuthority({
            ...local(),
            [key]: key === "epoch" ? 8 : "other",
          }),
          "owner",
        ),
      ownershipLost,
      key,
    );
  }
  assert.throws(
    () =>
      assertOwnerAttemptCaller(
        { ...localCaller(), ownerEpoch: 8 },
        local(),
        "owner",
      ),
    ownershipLost,
  );
});

test("attempt callers never interchange placement or accept owner control", () => {
  for (
    const [who, assignment] of [
      [localCaller(), worker()],
      [workerCaller(), local()],
      [controlCaller(), worker()],
      [controlCaller(), local()],
    ] as const
  ) {
    assert.throws(
      () => assertOwnerAttemptCaller(who, assignment, "owner"),
      ownershipLost,
    );
  }
});

test("authority coordinates require own canonical bounded identifiers", () => {
  for (const assignment of [worker(), local(), processor()]) {
    for (const [key, value] of Object.entries(assignment)) {
      assert.throws(
        () => ownerAttemptToken(asAuthority(without(assignment, key))),
        TypeError,
        key,
      );
      const malformed = typeof value === "number"
        ? [
          undefined,
          null,
          "7",
          0,
          -1,
          0.5,
          NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
        ]
        : [
          undefined,
          null,
          7,
          {},
          "",
          " ",
          " padded",
          "padded ",
          "x".repeat(1025),
        ];
      for (const replacement of malformed) {
        assert.throws(
          () =>
            ownerAttemptToken(
              asAuthority({ ...assignment, [key]: replacement }),
            ),
          TypeError,
          key,
        );
      }
    }
    assert.throws(
      () => ownerAttemptToken(asAuthority(Object.create(assignment))),
      TypeError,
    );
  }
  for (
    const value of [null, undefined, [], "worker", {}, { placement: "local" }]
  ) {
    assert.throws(() => ownerAttemptToken(asAuthority(value)), TypeError);
  }
  assert.throws(
    () =>
      ownerAttemptToken(
        asAuthority({ ...processor(), consumerId: "processor:other" }),
      ),
    TypeError,
  );
  assert.throws(
    () => ownerAttemptToken(asAuthority({ ...local(), kind: "unknown" })),
    TypeError,
  );
});

test("all helpers validate assignments rather than deriving authority from a token or NULL deadline", () => {
  for (
    const assignment of [without(local(), "placement"), {
      ...worker(),
      placement: undefined,
    }, { placement: "owner-local", attemptId: "attempt" }]
  ) {
    const input = asAuthority(assignment);
    assert.throws(
      () => assertOwnerAttemptCaller(localCaller(), input, "owner"),
      TypeError,
    );
    assert.throws(() => ownerAttemptToken(input), TypeError);
    assert.throws(
      () =>
        ownerAttemptIsLive(
          delivery({ leaseOwner: "attempt", leaseExpiresAt: undefined }),
          input,
        ),
      TypeError,
    );
    assert.throws(
      () => ownerEventCommitForAttempt(context(), input),
      TypeError,
    );
  }
});

test("authority snapshots reject placement and coordinate accessors without invoking them", () => {
  let reads = 0;
  for (const assignment of [worker(), local(), processor()]) {
    for (const key of Object.keys(assignment)) {
      const input = { ...assignment };
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads++;
          return "changed";
        },
      });
      assert.throws(() => ownerAttemptToken(input), TypeError, key);
    }
  }
  assert.equal(reads, 0);
});

test("richer assignment grants and invocation remain compatible but never flow into authority", () => {
  for (const assignment of [worker(), local(), processor()]) {
    const rich = {
      ...assignment,
      ctxGranted: false,
      settlementGranted: true,
      invocation: { actionRunId: "run", secret: "private" },
    };
    assert.equal(
      ownerAttemptToken(rich),
      assignment.placement === "worker" ? "dispatch" : "attempt",
    );
    assertOwnerAttemptCaller(
      assignment.placement === "worker" ? workerCaller() : localCaller(),
      rich,
      "owner",
    );
    const result = ownerEventCommitForAttempt(context(), rich);
    assert.equal("ctxGranted" in result, false);
    assert.equal("settlementGranted" in result, false);
    assert.equal("invocation" in result, false);
  }
});

test("foreign placement identity fields are rejected even when present undefined", () => {
  for (const value of ["foreign", undefined]) {
    for (const key of ["epoch", "holderId", "attemptId", "actionRunId"]) {
      assert.throws(
        () => ownerAttemptToken(asAuthority({ ...worker(), [key]: value })),
        TypeError,
        key,
      );
    }
    for (
      const key of [
        "workerId",
        "workerAttemptId",
        "sessionGeneration",
        "sessionId",
        "parentOperationId",
        "assignmentId",
        "dispatchAttemptId",
        "executionId",
      ]
    ) {
      assert.throws(
        () => ownerAttemptToken(asAuthority({ ...local(), [key]: value })),
        TypeError,
        key,
      );
      assert.throws(
        () => ownerAttemptToken(asAuthority({ ...processor(), [key]: value })),
        TypeError,
        key,
      );
    }
    for (const key of ["processorId", "consumerId"]) {
      assert.throws(
        () => ownerAttemptToken(asAuthority({ ...local(), [key]: value })),
        TypeError,
        key,
      );
    }
    for (const key of ["actionId", "actionRunId"]) {
      assert.throws(
        () => ownerAttemptToken(asAuthority({ ...processor(), [key]: value })),
        TypeError,
        key,
      );
    }
  }
});

test("caller identities reject missing, padded, oversized and extra principal fields", () => {
  for (
    const [who, assignment] of [[workerCaller(), worker()], [
      localCaller(),
      local(),
    ]] as const
  ) {
    for (const [key, value] of Object.entries(who.principal)) {
      const replacements = typeof value === "number"
        ? ["7", 0, NaN, 1.5]
        : ["", " ", " padded", "x".repeat(1025), undefined];
      for (const replacement of replacements) {
        assert.throws(() =>
          assertOwnerAttemptCaller(
            asCaller({
              ...who,
              principal: { ...who.principal, [key]: replacement },
            }),
            assignment,
            "owner",
          )
        );
      }
      assert.throws(() =>
        assertOwnerAttemptCaller(
          asCaller({ ...who, principal: without(who.principal, key) }),
          assignment,
          "owner",
        )
      );
    }
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          asCaller({
            ...who,
            principal: { ...who.principal, extra: undefined },
          }),
          assignment,
          "owner",
        ),
      TypeError,
    );
    for (const value of [undefined, null, "7", 0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () =>
          assertOwnerAttemptCaller(
            asCaller({ ...who, ownerEpoch: value }),
            assignment,
            "owner",
          ),
        TypeError,
      );
    }
    for (const ownerId of ["", " ", " owner", "x".repeat(1025)]) {
      assert.throws(
        () => assertOwnerAttemptCaller(who, assignment, ownerId),
        TypeError,
      );
    }
  }
});

test("caller principal and outer coordinates do not invoke getters", () => {
  let reads = 0;
  for (
    const key of [
      "principal",
      "ownerEpoch",
      "sessionId",
      "assignmentId",
      "dispatchAttemptId",
    ]
  ) {
    const who = { ...workerCaller() };
    Object.defineProperty(who, key, {
      enumerable: true,
      get() {
        reads++;
        return "changed";
      },
    });
    assert.throws(
      () => assertOwnerAttemptCaller(who, worker(), "owner"),
      TypeError,
    );
  }
  for (const key of Object.keys(localCaller().principal)) {
    const principal = { ...localCaller().principal };
    Object.defineProperty(principal, key, {
      enumerable: true,
      get() {
        reads++;
        return "changed";
      },
    });
    assert.throws(
      () =>
        assertOwnerAttemptCaller(
          { ...localCaller(), principal },
          local(),
          "owner",
        ),
      TypeError,
    );
  }
  assert.equal(reads, 0);
});

test("attempt tokens are placement-specific and never worker or holder identities", () => {
  assert.equal(ownerAttemptToken(worker()), "dispatch");
  assert.equal(ownerAttemptToken(local()), "attempt");
  assert.equal(ownerAttemptToken(processor()), "attempt");
});

test("worker liveness requires exact non-expiring owner attempt, not a deadline", () => {
  assert.equal(
    ownerAttemptIsLive(delivery({ leaseExpiresAt: null }), worker()),
    true,
  );
  for (
    const changes of [
      { id: "other" },
      { status: "ready" },
      { status: "succeeded" },
      { leaseOwner: "worker" },
      { leaseOwner: "attempt" },
      { leaseOwner: undefined },
      { leaseExpiresAt: now },
      { leaseExpiresAt: past },
      { leaseExpiresAt: future },
      { leaseExpiresAt: "invalid" },
      { leaseExpiresAt: "" },
      { leaseExpiresAt: 1 },
    ]
  ) {
    assert.equal(
      ownerAttemptIsLive(delivery(changes), worker()),
      false,
      JSON.stringify(changes),
    );
  }

  assert.equal(
    ownerAttemptIsLive(delivery({ leaseExpiresAt: null }), {
      ...worker(),
      deliveryId: "other",
    }),
    false,
  );
  assert.equal(
    ownerAttemptIsLive(
      delivery({ leaseExpiresAt: null }),
      { ...worker(), dispatchAttemptId: "other" },
    ),
    false,
  );
});

test("local liveness requires the exact NULL-deadline attempt and does not expire by clock", () => {
  for (const assignment of [local(), processor()]) {
    for (const leaseExpiresAt of [undefined, null]) {
      {
        assert.equal(
          ownerAttemptIsLive(
            delivery({ leaseOwner: "attempt", leaseExpiresAt }),
            assignment,
          ),
          true,
        );
      }
    }
    for (
      const changes of [
        { id: "other" },
        { status: "ready" },
        { status: "succeeded" },
        { leaseOwner: "dispatch" },
        { leaseOwner: "holder" },
        { leaseOwner: undefined },
        { leaseExpiresAt: future },
        { leaseExpiresAt: now },
        { leaseExpiresAt: past },
        { leaseExpiresAt: "invalid" },
        { leaseExpiresAt: "" },
      ]
    ) {
      assert.equal(
        ownerAttemptIsLive(
          delivery({
            leaseOwner: "attempt",
            leaseExpiresAt: undefined,
            ...changes,
          }),
          assignment,
        ),
        false,
        JSON.stringify(changes),
      );
    }
  }
});

test("delivery liveness snapshots own data coordinates without invoking accessors", () => {
  let reads = 0;
  for (const assignment of [worker(), local()]) {
    for (const key of ["id", "status", "leaseOwner", "leaseExpiresAt"]) {
      const input = { ...delivery() };
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads++;
          return "changed";
        },
      });
      assert.throws(
        () => ownerAttemptIsLive(input, assignment),
        TypeError,
        key,
      );
    }
    assert.throws(
      () => ownerAttemptIsLive(Object.create(delivery()), assignment),
      TypeError,
    );
  }
  assert.equal(reads, 0);
  const input = without(
    delivery({ leaseOwner: "attempt" }),
    "leaseExpiresAt",
  ) as EventDelivery;
  assert.equal(ownerAttemptIsLive(input, local()), true);
  assert.equal(ownerAttemptIsLive(input, worker()), false);
  assert.equal(
    ownerAttemptIsLive(
      without(input, "leaseOwner") as EventDelivery,
      local(),
    ),
    false,
  );
});

test("event context derivation preserves exact command capabilities and copies only named fields", () => {
  const input = context();
  const enriched = {
    ...input,
    extra: "discard",
    ownerCommit: {
      ...input.ownerCommit,
      extra: "discard",
      afterCommit: () => {},
    },
  };
  const workerResult = ownerEventCommitForAttempt(enriched, worker());
  assert.deepEqual(workerResult, {
    ...input.ownerCommit,
    afterCommit,
    ownerAttempt: { deliveryId: "delivery", attemptId: "dispatch" },
  });
  const localResult = ownerEventCommitForAttempt(enriched, local());
  assert.deepEqual(localResult, {
    ...input.ownerCommit,
    afterCommit,
    ownerAttempt: { deliveryId: "delivery", attemptId: "attempt" },
  });
  assert.equal(workerResult.transaction, tx);
  assert.equal(localResult.transaction, tx);
  assert.equal(workerResult.afterCommit, afterCommit);
  assert.equal(localResult.afterCommit, afterCommit);
  assert.equal("ownerAttempt" in workerResult, true);
});

test("event context conversion is derivation, including separately authorized control-start candidates", () => {
  const input = { ...context(), caller: controlCaller() };
  assert.deepEqual(ownerEventCommitForAttempt(input, local()).ownerAttempt, {
    deliveryId: "delivery",
    attemptId: "attempt",
  });
  // No local selector is manufactured from a local caller tag alone.
  assert.equal(
    "ownerAttempt" in ownerEventCommitForAttempt(context(), worker()),
    true,
  );
});

test("event context rejects wrong transaction, owner, local epoch or holder and inconsistent time", () => {
  for (
    const [key, value] of [
      ["transaction", { query: tx.query }],
      ["ownerId", "other"],
      ["epoch", 8],
      ["holderId", "other"],
      ["commandTime", future],
    ] as const
  ) {
    const input = context();
    assert.throws(
      () =>
        ownerEventCommitForAttempt({
          ...input,
          ownerCommit: { ...input.ownerCommit, [key]: value },
        }, local()),
      ownershipLost,
      key,
    );
  }
  assert.throws(
    () =>
      ownerEventCommitForAttempt(
        { ...context(), commandTime: future },
        local(),
      ),
    ownershipLost,
  );
  assert.throws(
    () =>
      ownerEventCommitForAttempt(
        { ...context(), tx: { query: tx.query } },
        worker(),
      ),
    ownershipLost,
  );
  // Valid worker fence coordinates are carried from the actual boundary context.
  const input = context();
  const changed = {
    ...input,
    ownerCommit: { ...input.ownerCommit, epoch: 8, holderId: "new-holder" },
  };
  assert.equal(ownerEventCommitForAttempt(changed, worker()).epoch, 8);
});

test("event context rejects malformed owner coordinates and missing capabilities", () => {
  for (
    const [key, values] of [
      ["ownerId", ["", " owner", "x".repeat(1025)]],
      ["holderId", ["", " holder", "x".repeat(1025)]],
      ["epoch", [undefined, null, "7", 0, -1, 1.5, Infinity]],
    ] as const
  ) {
    for (const value of values) {
      const input = context();
      assert.throws(
        () =>
          ownerEventCommitForAttempt(
            asContext({
              ...input,
              ownerCommit: { ...input.ownerCommit, [key]: value },
            }),
            local(),
          ),
        TypeError,
        key,
      );
    }
  }
  for (const commandTime of ["", "invalid", null, 1]) {
    assert.throws(
      () =>
        ownerEventCommitForAttempt(
          asContext({ ...context(), commandTime }),
          local(),
        ),
      TypeError,
    );
  }
  for (const afterCommit of [null, undefined, true, "callback"]) {
    assert.throws(
      () =>
        ownerEventCommitForAttempt(
          asContext({ ...context(), afterCommit }),
          local(),
        ),
      TypeError,
    );
  }
  for (const key of ["tx", "ownerCommit", "commandTime", "afterCommit"]) {
    assert.throws(
      () =>
        ownerEventCommitForAttempt(asContext(without(context(), key)), local()),
      TypeError,
      key,
    );
  }
});

test("worker context refuses malformed or foreign attempt selectors, including undefined", () => {
  for (
    const ownerAttempt of [undefined, null, {}, {
      deliveryId: "delivery",
      attemptId: "attempt",
    }]
  ) {
    const input = context();
    assert.throws(
      () =>
        ownerEventCommitForAttempt(
          asContext({
            ...input,
            ownerCommit: { ...input.ownerCommit, ownerAttempt },
          }),
          worker(),
        ),
      ownerAttempt && "attemptId" in ownerAttempt ? ownershipLost : TypeError,
    );
  }
});

test("local context accepts an exact preexisting selector and rejects contradictions or extra keys", () => {
  const input = context();
  const withAttempt = (ownerAttempt: unknown) => ({
    ...input,
    ownerCommit: { ...input.ownerCommit, ownerAttempt },
  });
  assert.deepEqual(
    ownerEventCommitForAttempt(
      withAttempt({ deliveryId: "delivery", attemptId: "attempt" }),
      local(),
    ).ownerAttempt,
    { deliveryId: "delivery", attemptId: "attempt" },
  );
  for (
    const ownerAttempt of [
      undefined,
      null,
      {},
      [],
      { deliveryId: "delivery" },
      { attemptId: "attempt" },
      { deliveryId: "other", attemptId: "attempt" },
      { deliveryId: "delivery", attemptId: "other" },
      { deliveryId: "delivery", attemptId: "attempt", extra: undefined },
      {
        deliveryId: "delivery",
        attemptId: "attempt",
        dispatchAttemptId: "attempt",
      },
      {
        deliveryId: "delivery",
        attemptId: "attempt",
        [Symbol("hidden")]: true,
      },
      Object.create({ deliveryId: "delivery", attemptId: "attempt" }),
    ]
  ) {
    assert.throws(() =>
      ownerEventCommitForAttempt(withAttempt(ownerAttempt), local())
    );
  }
});

test("event context and selector accessors are rejected without invocation", () => {
  let reads = 0;
  const getter = {
    enumerable: true,
    get() {
      reads++;
      return "changed";
    },
  };
  for (const key of ["ownerCommit", "tx", "commandTime", "afterCommit"]) {
    const input = { ...context() };
    Object.defineProperty(input, key, getter);
    assert.throws(() => ownerEventCommitForAttempt(input, local()), TypeError);
  }
  for (
    const key of [
      "ownerId",
      "epoch",
      "holderId",
      "transaction",
      "commandTime",
      "ownerAttempt",
    ]
  ) {
    const input = context();
    const ownerCommit = { ...input.ownerCommit };
    Object.defineProperty(ownerCommit, key, getter);
    assert.throws(
      () => ownerEventCommitForAttempt({ ...input, ownerCommit }, local()),
      TypeError,
    );
  }
  for (const key of ["deliveryId", "attemptId"]) {
    const input = context();
    const ownerAttempt = { deliveryId: "delivery", attemptId: "attempt" };
    Object.defineProperty(ownerAttempt, key, getter);
    assert.throws(
      () =>
        ownerEventCommitForAttempt(
          asContext({
            ...input,
            ownerCommit: { ...input.ownerCommit, ownerAttempt },
          }),
          local(),
        ),
      TypeError,
    );
  }
  assert.equal(reads, 0);
});

test("returned context and tuple remain detached from later assignment and source mutation", () => {
  const assignment = { ...local() };
  const sourceAttempt = { deliveryId: "delivery", attemptId: "attempt" };
  const input = context();
  const ownerCommit = { ...input.ownerCommit, ownerAttempt: sourceAttempt };
  const result = ownerEventCommitForAttempt(
    { ...input, ownerCommit },
    assignment,
  );
  assignment.deliveryId = "changed";
  assignment.attemptId = "changed";
  assignment.epoch = 8;
  assignment.holderId = "changed";
  sourceAttempt.deliveryId = "changed";
  sourceAttempt.attemptId = "changed";
  ownerCommit.ownerId = "changed";
  ownerCommit.epoch = 9;
  ownerCommit.holderId = "changed";
  ownerCommit.commandTime = future;
  assert.deepEqual(result, {
    transaction: tx,
    ownerId: "owner",
    epoch: 7,
    holderId: "holder",
    commandTime: now,
    afterCommit,
    ownerAttempt: { deliveryId: "delivery", attemptId: "attempt" },
  });
  assert.notEqual(result.ownerAttempt, sourceAttempt);
  const second = ownerEventCommitForAttempt(context(), local());
  assert.notEqual(result.ownerAttempt, second.ownerAttempt);
});

test("canonical local binding byte bounds still apply after selecting richer fields", () => {
  const assignment = { ...local() } as Record<string, unknown>;
  for (
    const key of [
      "ownerId",
      "holderId",
      "attemptId",
      "namespace",
      "sourceEventId",
      "deliveryId",
      "actionId",
      "actionRunId",
    ]
  ) {
    assignment[key] = "😀".repeat(512);
  }
  assert.throws(
    () => ownerAttemptToken(asAuthority({ ...assignment, ctxGranted: true })),
    /encoded byte limit/,
  );
});
