import { test } from "node:test";
import assert from "node:assert/strict";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOwnerPreparationResources,
  type OwnerPreparationResourcesOptions,
} from "./preparation-resources.ts";
import type { OwnerJson } from "./boundary.ts";
const tx = {
  query() {
    throw new Error("No SQL outside explicit policy");
  },
};
const context = () => ({
  caller: {
    principal: { kind: "worker" as const, workerId: "worker" },
    ownerEpoch: 1,
  },
  scope: { namespace: "space", audience: "channel" },
  commandTime: "2020-01-01T00:00:00.000Z",
  signal: new AbortController().signal,
});
const resource = { namespace: "channel", alias: "style" };
function fixture(overrides: Partial<OwnerPreparationResourcesOptions> = {}) {
  const style = { prefix: "Reply:", hidden: "private" };
  const registry = createPluginRegistry({ resources: { channel: { style } } });
  let allowed = true;
  let projections = 0;
  const seen: Parameters<
    OwnerPreparationResourcesOptions["authorizeResource"]
  >[1][] = [];
  const helper = createOwnerPreparationResources({
    registry,
    resources: [resource],
    projectResource(_tx, { value }) {
      projections++;
      return { prefix: (value as Record<string, OwnerJson>).prefix };
    },
    authorizeResource(_tx, value) {
      seen.push(structuredClone(value));
      if (!allowed) throw new Error("current resource denied");
      return true;
    },
    ...overrides,
  });
  return {
    helper,
    style,
    registry,
    seen,
    projections: () => projections,
    allow(value: boolean) {
      allowed = value;
    },
  };
}
test("preparation resources bind only authorized projections and replay original versions without reprojecting", async () => {
  const f = fixture();
  const first = await f.helper.capture(tx, context());
  assert.deepEqual(first.values, { channel: { style: { prefix: "Reply:" } } });
  f.style.hidden = "different private value";
  const hiddenEdit = await f.helper.capture(tx, context());
  assert.deepEqual(hiddenEdit.references, first.references);
  f.style.prefix = "New:";
  const visibleEdit = await f.helper.capture(tx, context());
  assert.notDeepEqual(visibleEdit.references, first.references);
  const before = f.projections();
  await f.helper.authorize(tx, first.references, context(), "duplicate");
  assert.equal(f.projections(), before);
  assert.deepEqual(f.seen.at(-1)?.reference, first.references[0]);
  assert.equal(f.seen.at(-1)?.purpose, "duplicate");
});
test("preparation resource policy cannot mutate private registry values or authority references", async () => {
  const f = fixture({
    projectResource(_tx, value) {
      (value.value as { prefix: string }).prefix = "projected";
      (value.scope as { audience: string }).audience = "forged";
      (value.resource as { alias: string }).alias = "forged";
      return value.value;
    },
    authorizeResource(_tx, value) {
      assert.equal(value.scope.audience, "channel");
      assert.equal(value.reference.alias, "style");
      (value.reference as { alias: string }).alias = "forged";
      (value.caller.principal as { workerId: string }).workerId = "forged";
      return true;
    },
  });
  const current = context();
  const captured = await f.helper.capture(tx, current);
  assert.equal(f.style.prefix, "Reply:");
  assert.equal(current.caller.principal.workerId, "worker");
  assert.equal(current.scope.audience, "channel");
  assert.equal(captured.references[0].alias, "style");
});
test("preparation resources refuse missing or forged coordinates and malformed duplicate references", async () => {
  const f = fixture();
  const captured = await f.helper.capture(tx, context());
  const original = captured.references[0];
  for (
    const references of [
      [{ ...original, alias: "other" }],
      [original, original],
      [{ ...original, digest: "no-digest" }],
      [{ ...original, value: "plaintext" }],
    ]
  ) {
    await assert.rejects(
      f.helper.authorize(tx, references, context(), "duplicate"),
      /preparation_resource_/,
    );
  }
  const missing = fixture({
    resources: [{ namespace: "missing", alias: "style" }],
  });
  await assert.rejects(
    missing.helper.capture(tx, context()),
    /preparation_resource_missing/,
  );
  assert.equal(missing.projections(), 0);
});
test("preparation resources refuse nested content/protected envelopes and aggregate oversized results", async () => {
  for (
    const projected of [
      { nested: { assetId: "asset" } },
      { nested: { bodyId: "body" } },
      { nested: { schema: "copilotz.action.lifecycle.protected.v1" } },
      { nested: { schema: "copilotz.action.protected-value.v1" } },
    ] as OwnerJson[]
  ) {
    const f = fixture({ projectResource: () => projected });
    await assert.rejects(
      f.helper.capture(tx, context()),
      /preparation_unsupported/,
    );
  }
  const large = fixture({
    maxBytes: 200,
    projectResource: () => ({ text: "x".repeat(100) }),
  });
  await assert.rejects(
    large.helper.capture(tx, context()),
    /preparation_limit/,
  );
  assert.throws(
    () => fixture({ resources: Array(33).fill(resource) }),
    /preparation_limit/,
  );
});
test("preparation resources enforce current capture/replay authorization and cancellation at output", async () => {
  const f = fixture();
  const captured = await f.helper.capture(tx, context());
  f.allow(false);
  await assert.rejects(
    f.helper.authorize(tx, captured.references, context(), "duplicate"),
    /current resource denied/,
  );
  await assert.rejects(
    f.helper.capture(tx, context()),
    /current resource denied/,
  );
  const control = new AbortController();
  const cancelled = fixture({
    authorizeResource() {
      control.abort(new Error("cancelled output"));
      return true;
    },
  });
  await assert.rejects(
    cancelled.helper.capture(tx, { ...context(), signal: control.signal }),
    /cancelled output/,
  );
});

test("preparation resources retain original signal and command time across asynchronous policy", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => finish = resolve);
  const control = new AbortController();
  const current = { ...context(), signal: control.signal };
  const f = fixture({
    async projectResource() {
      entered();
      await pending;
      return { prefix: "safe" };
    },
  });
  const work = f.helper.capture(tx, current);
  await started;
  current.signal = new AbortController().signal;
  current.commandTime = "2099-01-01T00:00:00.000Z";
  control.abort(new Error("original caller cancelled"));
  finish();
  await assert.rejects(work, /original caller cancelled/);
  assert.equal(f.seen.length, 0);

  const times: string[] = [];
  const replay = context();
  const originalTime = replay.commandTime;
  const two = fixture({
    resources: [resource, { namespace: "channel", alias: "other" }],
    authorizeResource(_tx, value) {
      times.push(value.commandTime);
      replay.commandTime = "2099-01-01T00:00:00.000Z";
      return true;
    },
  });
  const digest = `sha256:${"1".repeat(64)}`;
  await two.helper.authorize(
    tx,
    [{ ...resource, digest }, { namespace: "channel", alias: "other", digest }],
    replay,
    "duplicate",
  );
  assert.deepEqual(times, [originalTime, originalTime]);
});
