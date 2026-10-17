import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  type OwnerPlacementBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
import { parseOwnerPlacementBinding as existingParser } from "./assignments.ts";

const worker = {
  placement: "worker",
  workerId: "worker",
  workerAttemptId: "worker-attempt",
  sessionGeneration: 0,
  sessionId: "session",
  parentOperationId: "parent",
  assignmentId: "assignment",
  dispatchAttemptId: "dispatch",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
} as const;
const local = {
  placement: "owner-local",
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
} as const;
const bindings: OwnerPlacementBinding[] = [
  { ...worker, actionId: "action", executionId: "run" },
  { ...worker, kind: "processor", processorId: "processor" },
  { ...local, kind: "action", actionId: "action", actionRunId: "run" },
  {
    ...local,
    kind: "processor",
    processorId: "processor",
    consumerId: "processor:processor",
  },
];

test("placement leaf preserves canonical bytes and exact detached parser parity", () => {
  for (const binding of bindings) {
    for (
      const input of [
        binding,
        Object.assign(Object.create(null), binding),
        Object.fromEntries(Object.entries(binding).reverse()),
      ]
    ) {
      const actual = parseOwnerPlacementBinding(input);
      assert.deepEqual(actual, existingParser(input));
      assert.equal(
        JSON.stringify(actual),
        JSON.stringify(existingParser(input)),
      );
      assert.notEqual(actual, input);
      assert.equal(Object.getPrototypeOf(actual), Object.prototype);
    }
  }
});

test("placement leaf and original reject every missing, foreign or malformed coordinate", () => {
  const reject = (value: unknown) => {
    assert.throws(() => parseOwnerPlacementBinding(value));
    assert.throws(() => existingParser(value));
  };
  for (const binding of bindings) {
    reject({ ...binding, extra: "extra" });
    for (const key of Object.keys(binding)) {
      const missing = { ...binding } as Record<string, unknown>;
      delete missing[key];
      reject(missing);
      for (const value of [undefined, null, {}, [], true]) {
        reject({ ...binding, [key]: value });
      }
      if (key !== "epoch" && key !== "sessionGeneration") {
        for (
          const value of ["", " leading", "trailing ", "x".repeat(1025), 1]
        ) {
          reject({ ...binding, [key]: value });
        }
      }
    }
    reject({ ...binding, placement: "other" });
    if (binding.placement !== "owner-local" || binding.kind !== "action") {
      reject({ ...binding, kind: "action" });
    }
  }
  // An exact local Action is the one valid kind:action shape in the corpus.
  assert.deepEqual(parseOwnerPlacementBinding(bindings[2]), bindings[2]);
  for (
    const value of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]
  ) {
    reject({ ...bindings[0], sessionGeneration: value });
    reject({ ...bindings[2], epoch: value });
  }
  reject({ ...bindings[2], epoch: 0 });
  reject({ ...bindings[3], consumerId: "wrong" });
  reject({ ...bindings[2], dispatchAttemptId: "worker-only" });
  reject({ ...bindings[0], attemptId: "local-only" });
  for (
    const value of [null, undefined, [], new Date(), Object.create(bindings[2])]
  ) {
    reject(value);
  }
});

test("placement leaf never invokes accessors and rejects hidden/symbol data", () => {
  let calls = 0;
  for (const parser of [parseOwnerPlacementBinding, existingParser]) {
    for (const key of Object.keys(bindings[2])) {
      const value = { ...bindings[2] };
      Object.defineProperty(value, key, {
        enumerable: true,
        get() {
          calls++;
          return "unexpected";
        },
      });
      assert.throws(() => parser(value));
    }
    for (const key of ["hidden", Symbol("private")]) {
      const value = { ...bindings[2] };
      Object.defineProperty(value, key, { value: "unexpected" });
      assert.throws(() => parser(value));
    }
  }
  assert.equal(calls, 0);
});

test("placement leaf preserves PostgreSQL escaped UTF-8 byte budget", () => {
  assert.equal(OWNER_ASSIGNMENT_BINDING_MAX_BYTES, 16_384);
  const value = Object.fromEntries(
    Object.entries(bindings[0]).map(([key, value]) => [
      key,
      typeof value === "string" && key !== "placement"
        ? "\u0000".repeat(1024)
        : value,
    ]),
  );
  assert.throws(() => parseOwnerPlacementBinding(value), /byte limit/);
  assert.throws(() => existingParser(value), /byte limit/);
  assert.deepEqual(
    parseOwnerPlacementBinding({
      ...bindings[2],
      actionRunId: "🙂".repeat(512),
    }),
    existingParser({ ...bindings[2], actionRunId: "🙂".repeat(512) }),
  );
});
