import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionInvocationContext } from "./execution-context.ts";
import { createActionInvocationContext as legacyExport } from "./host.ts";
import { actionTransactionIdentity } from "./transaction-identity.ts";
import { actionTransactionIdentity as legacyIdentity } from "./invoker.ts";
import {
  resolveActionSourceData,
  withProtectedEventResolver,
} from "./protected-context.ts";

test("execution context preserves capability composition and compatibility exports", async () => {
  assert.equal(legacyExport, createActionInvocationContext);
  assert.equal(legacyIdentity, actionTransactionIdentity);
  const captured: unknown[] = [];
  const abort = new AbortController();
  const nested = { nested: () => "nested" };
  const host = withProtectedEventResolver({
    signal: new AbortController().signal,
    transaction: async (callback: () => unknown, options: unknown) => {
      captured.push(options);
      return await callback();
    },
    readSnapshot: (callback: () => unknown) => callback(),
    content: {
      prepare: (input: unknown, options: unknown) => {
        captured.push([input, options]);
        return "prepared";
      },
      publish: (input: unknown, options: unknown) => {
        captured.push([input, options]);
        return "published";
      },
    },
    streams: {
      open: (input: unknown) => {
        captured.push(input);
        return "stream";
      },
    },
  }, () => Promise.resolve({ hidden: "authorized" }));
  const context = createActionInvocationContext({
    host: host as never,
    frame: {
      actionId: "test.action",
      actionRunId: "run",
      operationKey: "root/step",
      rootKey: "root",
      parentActionRunId: "parent",
      metadata: {},
      identity: { causationId: "cause", settlementScopeId: "scope" },
      signal: abort.signal,
      nextActionIndex: () => 1,
    },
    actions: nested as never,
    progress: (value) => {
      captured.push(value);
      return Promise.resolve();
    },
    registerDeferredWait: (key, timeout) => {
      captured.push([key, timeout]);
      return Promise.resolve();
    },
  });
  assert.equal(context.actions, nested);
  assert.equal(context.signal, abort.signal);
  assert.equal(context.action.parentRunId, "parent");
  assert.throws(() => context.effect.begin("step"), {
    code: "action_effect_unavailable",
  });
  assert.throws(() => context.effect.confirm("step", "result"), {
    code: "action_effect_unavailable",
  });
  assert.deepEqual(await resolveActionSourceData(context), {
    hidden: "authorized",
  });
  const local = () => "local";
  assert.equal(await context.transaction(() => local), local);
  await context.transaction(() => null, {
    operationKey: "explicit",
    identity: { correlationId: "correlation" },
  });
  assert.deepEqual(captured[0], {
    operationKey: "root/step/transaction:1",
    identity: { causationId: "cause", settlementScopeId: "scope" },
    signal: abort.signal,
  });
  assert.deepEqual(captured[1], {
    operationKey: "root/step/explicit",
    identity: {
      causationId: "cause",
      settlementScopeId: "scope",
      correlationId: "correlation",
    },
    signal: abort.signal,
  });
  await context.content.prepare("input" as never, { operationKey: "prepare" });
  await context.content.publish({} as never, { operationKey: "publish" });
  context.streams.open(
    { metadata: { sourceActionRunId: "spoof", custom: "value" } } as never,
  );
  assert.deepEqual(captured[2], ["input", {
    operationKey: "root/step/prepare",
  }]);
  assert.deepEqual(captured[3], [{}, { operationKey: "root/step/publish" }]);
  assert.deepEqual(captured[4], {
    metadata: { sourceActionRunId: "run", custom: "value" },
  });
  await context.registerDeferredWait("wait", { timeoutMs: 20 });
  assert.deepEqual(captured[5], ["wait", 20]);
  abort.abort();
  assert.equal(context.signal.aborted, true);
});
