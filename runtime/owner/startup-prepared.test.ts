import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerPreparationIntent } from "./preparation-intent.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import {
  ownerPreparationChildKey,
  ownerPreparationKey,
} from "../execution/preparation-call.ts";
import {
  ownerAssignmentKey,
  type OwnerStoredAssignment,
} from "./assignments.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import {
  type OwnerPreparedHistoryEvent,
  type OwnerPreparedHistoryEvidence,
  type OwnerPreparedHistoryReceipt,
  validateClosedPreparedHistories,
} from "./startup-prepared.ts";
type MutableEvent =
  & Omit<
    {
      -readonly [K in keyof OwnerPreparedHistoryEvent]:
        OwnerPreparedHistoryEvent[K];
    },
    "metadata"
  >
  & { metadata: Record<string, unknown> };
type MutableReceipt = {
  -readonly [K in keyof OwnerPreparedHistoryReceipt]:
    OwnerPreparedHistoryReceipt[K];
};

async function fixture() {
  const local = ownerPreparationChildKey("context", "reply");
  const childRun = `parent/action:fixture.child:${local}`;
  const event = (
    id: string,
    run: string,
    actionId: string,
    metadata: Record<string, unknown> = {},
  ): MutableEvent => ({
    id,
    ownerId: "owner",
    namespace: "space",
    type: "copilotz.owner.action.requested",
    metadata: {
      actionId,
      actionRunId: run,
      actionMetadata: {},
      rootKey: "parent",
      ...metadata,
    },
    deduplicationId: run,
    causationId: id === "child-event" ? "parent-event" : null,
    correlationId: "correlation",
  });
  const parent = event("parent-event", "parent", "fixture.parent");
  const child = event("child-event", childRun, "fixture.child", {
    parentActionRunId: "parent",
    parentOperationKey: "parent",
    parentDeliveryId: "parent-delivery",
    localOperationKey: local,
    childDepth: 1,
    preparation: {
      schema: "copilotz.owner.preparation.v1",
      preparation: "context",
      source: {
        source: {
          name: "notes",
          kind: "note",
          selection: "record",
          recordId: "note-1",
          namespace: "space",
          digest: `sha256:${"a".repeat(64)}`,
        },
        audience: "reader",
        content: [],
      },
      resources: [],
      view: {
        shows: "note",
        hints: { mode: "context", renderer: "text" },
        selection: { kind: "registered", id: "original.view" },
      },
    },
  });
  function history(
    id: string,
    run: string,
    actionId: string,
  ): OwnerStoredAssignment {
    const binding = {
      placement: "worker" as const,
      workerId: `${id}-worker`,
      workerAttemptId: `${id}-worker-attempt`,
      sessionGeneration: 1,
      sessionId: `${id}-session`,
      parentOperationId: `${id}-stream`,
      assignmentId: `${id}-assignment`,
      dispatchAttemptId: `${id}-attempt`,
      namespace: "space",
      sourceEventId: `${id}-event`,
      deliveryId: `${id}-delivery`,
      actionId,
      executionId: run,
    };
    return {
      owner: "owner",
      epoch: 1,
      key: ownerAssignmentKey("owner", binding),
      binding,
      retired: true,
    };
  }
  const assignments = [
    history("parent", "parent", "fixture.parent"),
    history("child", childRun, "fixture.child"),
  ];
  function claim(id: string, run: string): MutableReceipt {
    return {
      owner: "owner",
      principalKind: "worker",
      principalId:
        ownerPrincipalIdentity({ kind: "worker", workerId: `${id}-worker` }).id,
      domain: "incarnation",
      key: ownerClaimKey("owner", `${id}-assignment`, `${id}-session`),
      kind: "execution.claim",
      intent: { assignmentId: `${id}-assignment`, sessionId: `${id}-session` },
      result: {
        executionId: run,
        deliveryId: `${id}-delivery`,
        dispatchAttemptId: `${id}-attempt`,
      },
    };
  }
  const receipts: MutableReceipt[] = [
    claim("parent", "parent"),
    claim("child", childRun),
    {
      owner: "owner",
      principalKind: "worker",
      principalId: '["parent-worker"]',
      domain: "logical",
      key: ownerPreparationKey("owner", "space", "parent", "context", "reply"),
      kind: "action.child-prepare",
      intent: await ownerPreparationIntent({
        preparation: "context",
        operationKey: "reply",
        parentOperationKey: "parent",
        source: "notes",
        recordId: "note-1",
        actionId: "fixture.child",
        hints: { mode: "context", renderer: "text" },
      }),
      result: {
        namespace: "space",
        actionId: "fixture.child",
        executionId: childRun,
        eventId: "child-event",
        deliveryId: "child-delivery",
      },
    },
  ];
  return {
    ownerId: "owner",
    epoch: 2,
    registrations: [{
      name: "context",
      actionId: "fixture.child",
      source: { name: "notes", kind: "note", selection: "record" as const },
      modes: ["context"],
      resources: [],
    }],
    events: [
      parent,
      child,
      ...["parent", "child"].flatMap((id) =>
        ["invoked", "terminal"].map((status) => ({
          ...event(
            `${id}-${status}`,
            id === "parent" ? "parent" : childRun,
            `fixture.${id}`,
          ),
          type: `fixture.${id}.${status}`,
        }))
      ),
    ],
    deliveries: ["parent", "child"].map((id) => ({
      id: `${id}-delivery`,
      eventId: `${id}-event`,
      consumerId: `registered:fixture.${id}`,
      settlementScopeId: "scope",
      actionScopeId: null,
      status: "succeeded",
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    })),
    receipts,
    assignments,
    closedActions: ["parent", "child"].map((id) => ({
      namespace: "space",
      actionId: `fixture.${id}`,
      executionId: id === "parent" ? "parent" : childRun,
      eventId: `${id}-event`,
      deliveryId: `${id}-delivery`,
      invokedId: `${id}-invoked`,
      terminalId: `${id}-terminal`,
      settlementScopeId: "scope",
      rootEventId: "parent-event",
    })),
    maxDerivedItems: 10_000,
    maxDerivedBytes: 1_048_576,
  } satisfies OwnerPreparedHistoryEvidence;
}
async function blocked(
  change: (data: Awaited<ReturnType<typeof fixture>>) => void,
) {
  const data = await fixture();
  change(data);
  const result = await validateClosedPreparedHistories(data);
  assert.ok(result.blockers.length);
  assert.deepEqual(result.matchedDeliveryIds, []);
}
test("closed prepared proof matches canonical child and receipt without current data or renderer", async () => {
  const data = await fixture();
  const result = await validateClosedPreparedHistories(data);
  assert.deepEqual(result.matchedDeliveryIds, ["child-delivery"]);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.derivedItems > 0 && result.derivedBytes > 0);
  // Retained values need neither today's source record nor today's View code.
  data.events[1].metadata.preparation = {
    ...(data.events[1].metadata.preparation as object),
    view: {
      shows: "historical.show",
      hints: { mode: "context", renderer: "text" },
      selection: { kind: "generic" },
    },
  };
  assert.deepEqual((await validateClosedPreparedHistories(data)).blockers, []);
});
test("closed prepared proof rejects missing, changed, duplicate and orphan receipts bidirectionally", async () => {
  await blocked((d) => {
    d.receipts.pop();
  });
  for (
    const field of [
      "owner",
      "domain",
      "key",
      "kind",
      "principalKind",
      "principalId",
    ] as const
  ) {
    await blocked((d) => {
      d.receipts[2][field] = "changed";
    });
  }
  await blocked((d) => {
    d.receipts[2].result = { changed: true };
  });
  await blocked((d) => {
    d.receipts[2].intent = { changed: true };
  });
  await blocked((d) => {
    d.receipts.push(structuredClone(d.receipts[2]));
  });
  const orphan = await fixture();
  orphan.events.splice(1, 1);
  const result = await validateClosedPreparedHistories(orphan);
  assert.ok(result.blockers.length);
  assert.deepEqual(result.matchedDeliveryIds, []);
});
test("closed prepared proof rejects source/target/mode/content/format substitution", async () => {
  await blocked((d) => {
    d.registrations = [];
  });
  await blocked((d) => {
    d.registrations[0].actionId = "other";
  });
  await blocked((d) => {
    d.registrations[0].source.kind = "other";
  });
  await blocked((d) => {
    d.registrations[0].modes = ["other"];
  });
  await blocked((d) => {
    d.events[1].metadata.preparation = null;
  });
  await blocked((d) => {
    const p = structuredClone(d.events[1].metadata.preparation) as Record<
      string,
      unknown
    >;
    p.source = {
      source: {
        name: "notes",
        kind: "note",
        path: "body",
        recordId: "note-1",
        namespace: "space",
        digest: `sha256:${"a".repeat(64)}`,
      },
      audience: "reader",
      content: [],
    };
    d.events[1].metadata.preparation = p;
  });
});
test("closed prepared proof binds original parent, operation, scope, local key and depth", async () => {
  for (
    const key of [
      "parentDeliveryId",
      "parentActionRunId",
      "parentOperationKey",
      "rootKey",
      "localOperationKey",
    ] as const
  ) {
    await blocked((d) => {
      d.events[1].metadata[key] = "changed";
    });
  }
  await blocked((d) => {
    d.events[1].metadata.childDepth = 2;
  });
  await blocked((d) => {
    d.events[1] = { ...d.events[1], correlationId: "other" };
  });
  await blocked((d) => {
    d.events[1] = { ...d.events[1], causationId: "other" };
  });
  await blocked((d) => {
    d.deliveries[1].settlementScopeId = "other";
  });
  await blocked((d) => {
    d.events[0].metadata.preparation = d.events[1].metadata.preparation;
  });
  await blocked((d) => {
    d.events[1].metadata.parentDeliveryId = "child-delivery";
  });
});
test("closed prepared proof requires one canonical executed claim and supports retired unstarted offers", async () => {
  await blocked((d) => {
    d.closedActions.splice(0, 1);
  });
  await blocked((d) => {
    d.receipts.splice(0, 1);
  });
  await blocked((d) => {
    d.receipts.push(structuredClone(d.receipts[0]));
  });
  await blocked((d) => {
    d.deliveries[0].attempts = 2;
  });
  await blocked((d) => {
    d.deliveries[1].status = "pending";
  });
  await blocked((d) => {
    d.assignments[0] = { ...d.assignments[0], epoch: 2 };
  });
  const d = await fixture(), previous = structuredClone(d.assignments[0]);
  const b = previous.binding;
  if (b.placement !== "worker") throw new Error("fixture");
  const binding = {
    ...b,
    assignmentId: "unstarted",
    sessionId: "old-session",
    dispatchAttemptId: "old-attempt",
  };
  d.assignments.push({
    ...previous,
    key: ownerAssignmentKey("owner", binding),
    binding,
  });
  assert.deepEqual((await validateClosedPreparedHistories(d)).blockers, []);
  d.assignments[2] = { ...d.assignments[2], retired: false };
  assert.ok((await validateClosedPreparedHistories(d)).blockers.length);
});
test("closed prepared evidence snapshots aliases before asynchronous intent hashing", async () => {
  const d = await fixture();
  const pending = validateClosedPreparedHistories(d);
  d.receipts[2].principalId = "changed";
  d.events[1].metadata.parentDeliveryId = "changed";
  d.registrations[0].actionId = "changed";
  assert.deepEqual((await pending).blockers, []);
});
test("closed prepared proof refuses incomplete item/byte evidence without partial matches", async () => {
  const d = await fixture(), full = await validateClosedPreparedHistories(d);
  for (
    const budget of [
      { maxDerivedItems: full.derivedItems - 1 },
      { maxDerivedBytes: full.derivedBytes - 1 },
      { maxDerivedItems: 0 },
      { maxDerivedBytes: 0 },
    ]
  ) {
    await assert.rejects(validateClosedPreparedHistories({ ...d, ...budget }), {
      code: "owner_prepared_history_inventory_incomplete",
    });
  }
  let called = 0;
  Object.defineProperty(d.events[1].metadata, "preparation", {
    enumerable: true,
    get() {
      called++;
      return null;
    },
  });
  await assert.rejects(validateClosedPreparedHistories(d));
  assert.equal(called, 0);
});

test("closed prepared proof refuses nested ordinary parents with potentially prepared ancestry", async () => {
  for (
    const [field, value] of [
      ["parentDeliveryId", "ancestor-delivery"],
      ["parentOperationKey", "ancestor"],
      ["parentActionRunId", "ancestor"],
      ["childDepth", 1],
      ["childDepth", null],
    ] as const
  ) {
    await blocked((d) => {
      d.events[0].metadata[field] = value;
    });
  }
});

test("closed prepared proof binds every optional first-claim contract coordinate to its historical assignment", async () => {
  for (const index of [0, 1]) {
    const data = await fixture();
    const history = data.assignments[index], b = history.binding;
    if (b.placement !== "worker" || "kind" in b) throw new Error("fixture");
    const contract = {
      protocol: "copilotz.owner-effects.v1",
      attempt: 1,
      ownerEpoch: history.epoch,
      ownerId: history.owner,
      namespace: b.namespace,
      actionId: b.actionId,
      actionRunId: b.executionId,
      sourceEventId: b.sourceEventId,
      deliveryId: b.deliveryId,
      workerId: b.workerId,
      assignmentId: b.assignmentId,
      sessionId: b.sessionId,
      dispatchAttemptId: b.dispatchAttemptId,
    };
    data.receipts[index].result = {
      ...(data.receipts[index].result as object),
      contract,
    };
    assert.deepEqual(
      (await validateClosedPreparedHistories(data)).blockers,
      [],
    );
    for (const field of Object.keys(contract)) {
      const changed = structuredClone(data);
      changed.receipts[index].result = {
        ...(changed.receipts[index].result as object),
        contract: {
          ...contract,
          [field]: ["attempt", "ownerEpoch"].includes(field) ? 2 : "foreign",
        },
      };
      assert.ok(
        (await validateClosedPreparedHistories(changed)).blockers.length,
        `${index}:${field}`,
      );
    }
  }
});

test("closed prepared proof refuses numeric, array and null parent selectors without coercion", async () => {
  const d = await fixture();
  d.deliveries[0].id = "123";
  d.closedActions[0].deliveryId = "123";
  d.receipts[0].result = {
    ...(d.receipts[0].result as object),
    deliveryId: "123",
  };
  const old = d.assignments[0], binding = { ...old.binding, deliveryId: "123" };
  d.assignments[0] = { ...old, binding };
  d.events[1].metadata.parentDeliveryId = "123";
  assert.deepEqual((await validateClosedPreparedHistories(d)).blockers, []);
  for (const selector of [123, ["123"], null]) {
    const changed = structuredClone(d);
    changed.events[1].metadata.parentDeliveryId = selector;
    assert.ok((await validateClosedPreparedHistories(changed)).blockers.length);
  }
});
