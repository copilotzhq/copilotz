import assert from "node:assert/strict";
const test = Deno.test;
import { normalizeActionNamedPreparation } from "./preparation-call.ts";
const request = () => ({
  preparation: "agent.note-context",
  recordId: "note-1",
  mode: "context",
});
test("named preparation data preserves existing semantic keys and normalizes the explicit local key", () => {
  const signal = new AbortController().signal;
  const input = request();
  const result = normalizeActionNamedPreparation(input, {
    operationKey: " reason ",
    signal,
  });
  assert.equal(result.operationKey, "reason");
  assert.equal(result.signal, signal);
  input.recordId = "mutated";
  assert.equal(result.request.recordId, "note-1");
});
test("named preparation data refuses absent keys, factories and caller authority", () => {
  for (
    const input of [
      undefined,
      null,
      [],
      () => request(),
      { ...request(), factory: () => ({}) },
      { ...request(), actionId: "other" },
      { ...request(), namespace: "other" },
      { ...request(), preparation: " " },
      { ...request(), mode: "context " },
      { ...request(), recordId: "x".repeat(1025) },
    ]
  ) {
    assert.throws(() =>
      normalizeActionNamedPreparation(input, { operationKey: "reason" })
    );
  }
  for (
    const options of [
      undefined,
      null,
      {},
      { operationKey: " " },
      { operationKey: "reason", identity: {} },
      { operationKey: "reason", metadata: {} },
      { operationKey: "reason", signal: {} },
    ]
  ) {
    assert.throws(() => normalizeActionNamedPreparation(request(), options));
  }
});
test("named preparation data rejects accessors and symbols without evaluation", () => {
  let calls = 0;
  const input = Object.defineProperty(request(), "recordId", {
    enumerable: true,
    get() {
      calls++;
      return "note";
    },
  });
  const options = {
    get operationKey() {
      calls++;
      return "reason";
    },
  };
  assert.throws(() =>
    normalizeActionNamedPreparation(input, { operationKey: "reason" })
  );
  assert.throws(() => normalizeActionNamedPreparation(request(), options));
  assert.throws(() =>
    normalizeActionNamedPreparation({
      ...request(),
      [Symbol("authority")]: "owner",
    }, { operationKey: "reason" })
  );
  assert.equal(calls, 0);
});
