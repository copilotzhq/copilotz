/** Callback data isolation only; actual SQL settlement coverage lives beside this file. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlExecutor } from "../events/session.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
} from "./boundary.ts";
import {
  createOwnerOperationSettlement,
  OWNER_OPERATION_READINESS,
  ownerOperationSettlementKey,
} from "./settlement.ts";
const time = "2020-01-01T00:00:00.000Z";
const target = { namespace: "space", operationId: "operation" };
const caller = (): OwnerCaller => ({
  principal: {
    kind: "owner-control",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
  },
  ownerEpoch: 1,
});
const base = () => ({
  ownerId: "owner",
  schema: "public",
  session: {} as never,
  catalog: { databaseSchema: "public" } as never,
  authorizeControl: () => true,
  selectDrains: () => [],
  authorizeDrain: () => true,
  drain: () => Promise.resolve(true),
  wake() {},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const plan = (withDrain = true) => ({
  status: "ready",
  ticket: {
    ...target,
    epoch: 1,
    nextEventOrdinal: "1",
    nextStreamOrdinal: "1",
    drains: withDrain
      ? [{ deliveryId: "delivery", dispatchAttemptId: "attempt" }]
      : [],
  },
});

test("settlement callback cannot mutate private authorized scope", async () => {
  const queries: unknown[][] = [];
  const tx: SqlExecutor = {
    query(sql, params) {
      if (sql.startsWith("SELECT fingerprint")) {
        return Promise.resolve({
          rows: [{ fingerprint: "owner-content-v1" }],
        }) as never;
      }
      queries.push(params ?? []);
      return Promise.resolve({ rows: [] });
    },
  };
  const settlement = createOwnerOperationSettlement({
    ...base(),
    authorizeControl(_tx, _caller, scope) {
      Object.assign(scope, {
        namespace: "substitute",
        operationId: "substitute",
      });
      return true;
    },
  });
  await settlement.authorize(tx, caller(), {
    kind: OWNER_OPERATION_READINESS,
    domain: "occurrence",
    key: "read",
    intent: target,
  }, time);
  await settlement.projections[OWNER_OPERATION_READINESS](null, {
    tx,
    caller: caller(),
    commandTime: time,
    signal: new AbortController().signal,
  });
  assert.deepEqual(queries[0], ["space", "operation"]);
});

test("settlement run captures caller occurrence and boundary across pending readiness", async () => {
  const ready = deferred<ReturnType<typeof plan>>();
  const calls: { caller: OwnerCaller; command: OwnerCommand }[] = [];
  const boundary: Pick<OwnerCommandBoundary, "project" | "execute"> = {
    project: () => ready.promise,
    execute(who, command) {
      calls.push({ caller: who, command });
      return Promise.resolve({
        status: "committed",
        result: { status: "pending" },
      });
    },
  };
  const input = {
    boundary,
    caller: caller(),
    target: { ...target },
    occurrence: "original",
  };
  const settlement = createOwnerOperationSettlement(base());
  const pending = settlement.run(input);
  input.occurrence = "substitute";
  Object.assign(input.caller.principal, { holderId: "substitute" });
  input.boundary = {
    project: () => Promise.reject(new Error("replacement port")),
    execute: () => Promise.reject(new Error("replacement port")),
  };
  ready.resolve(plan(false));
  await pending;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].caller, caller());
  assert.equal(
    calls[0].command.key,
    ownerOperationSettlementKey("owner", target, "original"),
  );
  assert.equal(
    (calls[0].command.intent as { occurrence: string }).occurrence,
    "original",
  );
});

test("settlement relay callback cannot rewrite drain identity or shared tombstone", async () => {
  let drains = 0;
  const commands: OwnerCommand[] = [];
  const settlement = createOwnerOperationSettlement({
    ...base(),
    drain(scope, ref) {
      drains++;
      Object.assign(scope, {
        namespace: "substitute",
        operationId: "substitute",
      });
      Object.assign(ref, {
        deliveryId: "substitute",
        dispatchAttemptId: "substitute",
      });
      return Promise.resolve(true);
    },
  });
  const boundary: Pick<OwnerCommandBoundary, "project" | "execute"> = {
    project: () => Promise.resolve(plan()),
    execute(_caller, command) {
      commands.push(structuredClone(command));
      return Promise.resolve({
        status: "committed",
        result: { status: "pending" },
      });
    },
  };
  await settlement.run({
    boundary,
    caller: caller(),
    target,
    occurrence: "first",
  });
  await settlement.run({
    boundary,
    caller: caller(),
    target,
    occurrence: "second",
  });
  assert.equal(drains, 1);
  for (const [index, command] of commands.entries()) {
    assert.equal(
      command.key,
      ownerOperationSettlementKey("owner", target, index ? "second" : "first"),
    );
    assert.deepEqual(
      (command.intent as { ticket: unknown }).ticket,
      plan().ticket,
    );
  }
});

test("settlement captures configured policy and relay callbacks", async () => {
  let drains = 0;
  const options = {
    ...base(),
    drain: () => {
      drains++;
      return Promise.resolve(true);
    },
  };
  const settlement = createOwnerOperationSettlement(options);
  options.authorizeControl = () => false;
  options.drain = () => Promise.reject(new Error("replacement relay"));
  const tx: SqlExecutor = { query: () => Promise.resolve({ rows: [] }) };
  await settlement.authorize(tx, caller(), {
    kind: OWNER_OPERATION_READINESS,
    domain: "occurrence",
    key: "read",
    intent: target,
  }, time);
  await settlement.run({
    caller: caller(),
    target,
    occurrence: "once",
    boundary: {
      project: () => Promise.resolve(plan()),
      execute: () =>
        Promise.resolve({ status: "committed", result: { status: "pending" } }),
    },
  });
  assert.equal(drains, 1);
});
