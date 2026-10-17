import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerPreparations, ownerPreparationKey } from "./preparation.ts";
import type { OwnerJson } from "./boundary.ts";
function unavailable(): never {
  throw new Error("Normalization cannot read or execute");
}
function commands(actionId = "fixture.send") {
  return createOwnerPreparations({
    ownerId: "owner",
    schema: "public",
    registry: createPluginRegistry({
      actions: { send: defineAction({ id: actionId, execute: unavailable }) },
    }),
    children: {
      authorizeTarget: unavailable,
      inspectPrepared: unavailable,
      admitPrepared: unavailable,
    },
    source: {
      capture: unavailable,
      authorizeOriginal: unavailable,
      projections: { "preparation.source": unavailable },
    },
    preparations: {
      channelText: {
        source: "messages",
        actionAlias: "send",
        shows: "message",
        modes: ["channel"],
        mapInput: unavailable,
      },
    },
    projectResource: unavailable,
    authorizeResource: unavailable,
  });
}
const input = () => ({
  parent: {
    deliveryId: "delivery-1",
    dispatchAttemptId: "attempt-1",
    operationKey: "parent",
  },
  preparation: "channelText",
  targetActionId: "fixture.send",
  operationKey: "reply",
  recordId: "message-1",
  hints: { mode: "channel", renderer: "text" },
});
test("named preparation requires the bound target assertion before normalization", async () => {
  const c = commands();
  const { targetActionId: _target, ...missing } = input();
  await assert.rejects(
    async () => await c.inputDefinition.normalize(missing),
    /preparation_/,
  );
  for (const targetActionId of ["fixture.other", "", ["fixture.send"], null]) {
    await assert.rejects(
      async () =>
        await c.inputDefinition.normalize({ ...input(), targetActionId }),
      /preparation_/,
    );
  }
  const normalized = await c.inputDefinition.normalize({
    ...input(),
    targetActionId: "fixture.send",
  });
  assert.equal(
    (normalized.value as { actionId: string }).actionId,
    "fixture.send",
  );
  assert.equal(
    Object.hasOwn(normalized.value as object, "targetActionId"),
    false,
  );
});
test("named preparation intent binds semantic registered input while excluding transport attempt coordinates", async () => {
  const c = commands();
  const first = await c.inputDefinition.normalize(input());
  assert.deepEqual(first.intent, {
    encoding: "copilotz.preparation.v1",
    digest:
      "sha256:95398fa5240dc9dc7e9eaf8a5a46db15c60481e8511645c44f48fbb8a14dbc1c",
  });
  const replacement = await c.inputDefinition.normalize({
    ...input(),
    parent: {
      ...input().parent,
      deliveryId: "delivery-2",
      dispatchAttemptId: "attempt-2",
    },
  });
  assert.deepEqual(first.intent, replacement.intent);
  assert.notDeepEqual(first.value, replacement.value);
  for (
    const changed of [{ ...input(), recordId: "other" }, {
      ...input(),
      operationKey: "other",
    }, { ...input(), parent: { ...input().parent, operationKey: "other" } }]
  ) {
    assert.notDeepEqual(
      (await c.inputDefinition.normalize(changed)).intent,
      first.intent,
    );
  }
  assert.notDeepEqual(
    (await commands("fixture.changed").inputDefinition.normalize({
      ...input(),
      targetActionId: "fixture.changed",
    }))
      .intent,
    first.intent,
  );
  assert.equal(
    ownerPreparationKey("owner", "space", "parent", "channelText", "reply"),
    '["action.child-prepare","owner","space","parent","channelText","reply"]',
  );
});
test("named preparation normalization refuses caller output, renderer/resource authority and unknown registrations", async () => {
  const c = commands();
  const bad: OwnerJson[] = [
    { ...input(), input: { text: "worker rendered" } },
    { ...input(), resources: { secret: "caller" } },
    { ...input(), actionId: "other" },
    { ...input(), preparation: "unregistered" },
    { ...input(), hints: { mode: "channel", renderer: "html" } },
    { ...input(), hints: { mode: "unknown", renderer: "text" } },
    { ...input(), parent: { ...input().parent, ownerEpoch: 99 } },
    { ...input(), recordId: "x".repeat(1025) },
  ];
  for (const value of bad) {
    await assert.rejects(
      Promise.resolve().then(() => c.inputDefinition.normalize(value)),
      /preparation_/,
    );
  }
  assert.equal(c.snapshot().pending, 0);
});

test("named preparation snapshots callback identity and detaches normalized callback arguments", async () => {
  let original = 0;
  const children = {
    authorizeTarget(
      _tx: unknown,
      _caller: unknown,
      parent: { operationKey: string },
    ) {
      original++;
      parent.operationKey = "callback mutation";
      return Promise.resolve({
        parent: { namespace: "space", operationKey: "parent" },
        actionId: "fixture.send",
      });
    },
    inspectPrepared: unavailable,
    admitPrepared: unavailable,
  };
  const c = createOwnerPreparations({
    ownerId: "owner",
    schema: "public",
    registry: createPluginRegistry({
      actions: {
        send: defineAction({ id: "fixture.send", execute: unavailable }),
      },
    }),
    children:
      children as unknown as import("./preparation.ts").PreparationChildAdmission,
    source: {
      capture: unavailable,
      authorizeOriginal: unavailable,
      projections: { "preparation.source": unavailable },
    },
    preparations: {
      channelText: {
        source: "messages",
        actionAlias: "send",
        shows: "message",
        modes: ["channel"],
        mapInput: unavailable,
      },
    },
    projectResource: unavailable,
    authorizeResource: unavailable,
  });
  const normalized = await c.inputDefinition.normalize(input());
  children.authorizeTarget = () => {
    throw new Error("replacement callback invoked");
  };
  await c.authorize(
    { query: () => Promise.resolve({ rows: [] }) } as never,
    { principal: { kind: "worker", workerId: "worker" }, ownerEpoch: 1 },
    {
      kind: "action.child-prepare",
      domain: "logical",
      key: ownerPreparationKey(
        "owner",
        "space",
        "parent",
        "channelText",
        "reply",
      ),
      intent: normalized.intent,
    },
    "2020-01-01T00:00:00.000Z",
    normalized.value,
  );
  assert.equal(original, 1);
  assert.equal(
    (normalized.value as { parent: { operationKey: string } }).parent
      .operationKey,
    "parent",
  );
});

test("named preparation refuses a captured namespace different from its current parent before evaluation or append", async () => {
  let mapped = 0;
  let appended = 0;
  const c = createOwnerPreparations({
    ownerId: "owner",
    schema: "public",
    registry: createPluginRegistry({
      actions: {
        send: defineAction({ id: "fixture.send", execute: unavailable }),
      },
    }),
    children: {
      authorizeTarget: () =>
        Promise.resolve({
          parent: { namespace: "space", operationKey: "parent" },
          actionId: "fixture.send",
        }),
      inspectPrepared: unavailable,
      admitPrepared() {
        appended++;
        return Promise.reject(new Error("must not append"));
      },
    } as unknown as import("./preparation.ts").PreparationChildAdmission,
    source: {
      capture: () =>
        Promise.resolve({
          projection: { record: { title: "wrong scope" } },
          reference: {
            source: {
              name: "messages",
              kind: "message",
              path: "content",
              recordId: "message-1",
              namespace: "other",
              digest: `sha256:${"1".repeat(64)}`,
            },
            audience: "channel",
            content: [],
          },
        }),
      authorizeOriginal: unavailable,
      projections: { "preparation.source": unavailable },
    },
    preparations: {
      channelText: {
        source: "messages",
        actionAlias: "send",
        shows: "message",
        modes: ["channel"],
        mapInput: (text) => {
          mapped++;
          return { text };
        },
      },
    },
    projectResource: unavailable,
    authorizeResource: unavailable,
  });
  const normalized = await c.inputDefinition.normalize(input());
  const tx = { query: () => Promise.resolve({ rows: [] }) } as never;
  const caller = {
    principal: { kind: "worker" as const, workerId: "worker" },
    ownerEpoch: 1,
  };
  const command = {
    kind: "action.child-prepare",
    domain: "logical" as const,
    key: ownerPreparationKey(
      "owner",
      "space",
      "parent",
      "channelText",
      "reply",
    ),
  };
  const commandTime = "2020-01-01T00:00:00.000Z";
  await c.authorize(
    tx,
    caller,
    { ...command, intent: normalized.intent },
    commandTime,
    normalized.value,
  );
  await assert.rejects(
    Promise.resolve(c.handler(normalized.intent, {
      tx,
      caller,
      command,
      input: normalized.value,
      commandTime,
      signal: new AbortController().signal,
      ownerCommit: {
        transaction: tx,
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        commandTime,
      },
      afterCommit: unavailable,
    })),
    /preparation_forbidden/,
  );
  assert.equal(mapped, 0);
  assert.equal(appended, 0);
});
