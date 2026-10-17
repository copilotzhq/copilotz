import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOwnerEffectClient,
  ownerEffectKey,
  type OwnerEffectPort,
} from "./effects-client.ts";
import type { OwnerCommandOutcome, OwnerJson } from "./boundary.ts";
const target = { namespace: "space", actionRunId: "run", step: "send" };
function fixture() {
  const state = {
    execute: 0,
    settle: 0,
    project: 0,
    outcome: {
      status: "committed",
      result: { ...target, status: "begun" },
    } as OwnerCommandOutcome,
    projection: { ...target, status: "begun" } as OwnerJson,
    error: undefined as unknown,
  };
  const port: OwnerEffectPort = {
    execute() {
      state.execute++;
      if (state.error) return Promise.reject(state.error);
      return Promise.resolve(state.outcome);
    },
    settle() {
      state.settle++;
      if (state.error) return Promise.reject(state.error);
      return Promise.resolve(state.outcome);
    },
    project() {
      state.project++;
      return Promise.resolve(state.projection);
    },
  };
  return {
    state,
    port,
    client: createOwnerEffectClient({ ownerId: "owner", ...target, port }),
  };
}

test("effect client has no implicit retry or effect permission after transport uncertainty", async () => {
  const f = fixture();
  f.state.error = Object.assign(new Error("lost after Start"), {
    execution: "indeterminate",
  });
  await assert.rejects(f.client.begin("send"), /lost after Start/);
  assert.equal(f.state.execute, 1);
  assert.equal(f.state.project, 0);
  assert.deepEqual(await f.client.inspect("send"), { status: "indeterminate" });
});

test("effect client refuses historical proceed, wrong-scope or impossible duplicate acknowledgements", async () => {
  for (
    const result of [
      { ...target, status: "proceed" },
      { ...target, actionRunId: "other", status: "begun" },
      { ...target, status: "begun", permit: true },
    ]
  ) {
    const f = fixture();
    f.state.outcome = { status: "duplicate", result };
    await assert.rejects(f.client.begin("send"), /effect/i);
  }
  const f = fixture();
  f.state.outcome = {
    status: "duplicate",
    result: { ...target, status: "begun" },
  };
  f.state.projection = { ...target, status: "none" };
  await assert.rejects(f.client.begin("send"), /receipt is missing/);
});

test("only known completion produces proceed; abort before acknowledgement withholds it", async () => {
  let resolve!: (value: OwnerCommandOutcome) => void;
  const completed = new Promise<OwnerCommandOutcome>((done) => resolve = done);
  const f = fixture();
  const controller = new AbortController();
  const client = createOwnerEffectClient({
    ownerId: "owner",
    ...target,
    port: { ...f.port, execute: () => completed },
  });
  let exposed = false;
  const pending = client.begin("send", { signal: controller.signal }).then(
    () => {
      exposed = true;
    },
  );
  await Promise.resolve();
  assert.equal(exposed, false);
  controller.abort(new Error("cancelled before known response"));
  resolve({ status: "committed", result: { ...target, status: "begun" } });
  await assert.rejects(pending, /cancelled before known response/);
  assert.equal(exposed, false);
});

test("effect client uses separate settlement and current-state ports", async () => {
  const f = fixture();
  assert.deepEqual(await f.client.begin("send"), { status: "proceed" });
  f.state.outcome = {
    status: "committed",
    result: { ...target, status: "confirmed", outcome: { messageId: "m" } },
  };
  await f.client.confirm("send", { messageId: "m" });
  f.state.projection = f.state.outcome.result;
  assert.deepEqual(await f.client.inspect("send"), {
    status: "replay",
    outcome: { messageId: "m" },
  });
  assert.deepEqual([f.state.execute, f.state.settle, f.state.project], [
    1,
    1,
    1,
  ]);
});

test("effect input validation never invokes getters and scopes delimit ambiguous strings", async () => {
  const f = fixture();
  let reads = 0;
  const input = Object.defineProperty({}, "token", {
    enumerable: true,
    get() {
      reads++;
      return "plaintext";
    },
  });
  await assert.rejects(f.client.confirm("send", input), /data properties/);
  assert.equal(reads, 0);
  assert.equal(f.state.settle, 0);
  assert.notEqual(
    ownerEffectKey(
      "owner",
      { namespace: "a:b", actionRunId: "c", step: "d" },
      "begin",
    ),
    ownerEffectKey(
      "owner",
      { namespace: "a", actionRunId: "b:c", step: "d" },
      "begin",
    ),
  );
});
