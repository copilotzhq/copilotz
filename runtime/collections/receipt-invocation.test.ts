import { assertEquals, assertThrows } from "@std/assert";
import {
  bindOwnerCollectionInvocation,
  closeCollectionPolicyInvocation,
  collectionReceiptInvocation,
  preserveCollectionInvocation,
} from "../authorization/invocation.ts";

Deno.test("receipt identity comes only from the immutable owner binding and survives Processor attempt replacement", () => {
  const owner = {
    scope: { databaseSchema: "public", namespace: "space" },
    logicalRunId: "delivery",
    signal: new AbortController().signal,
    resolveSource() {
      throw new Error("not used");
    },
  };
  const first = bindOwnerCollectionInvocation(
    { operationKey: "worker-selected" },
    owner,
    { kind: "processor", id: "consumer", runId: "attempt-a" },
  );
  const second = bindOwnerCollectionInvocation(
    { operationKey: "changed" },
    owner,
    { kind: "processor", id: "consumer", runId: "attempt-b" },
  );
  const expected = {
    scope: { databaseSchema: "public", namespace: "space" },
    invocation: { kind: "processor", id: "consumer", runId: "delivery" },
  };
  assertEquals(collectionReceiptInvocation(first), expected);
  assertEquals(collectionReceiptInvocation(second), expected);
  assertEquals(collectionReceiptInvocation({ ...first }), undefined);
  owner.logicalRunId = "modified-registration";
  owner.scope.namespace = "modified-registration";
  assertEquals(collectionReceiptInvocation(first), expected);
  const action = bindOwnerCollectionInvocation(
    { action: { id: "forged", runId: "forged" } },
    owner,
    { kind: "action", id: "owner-action", runId: "original-run" },
  );
  assertEquals(collectionReceiptInvocation(action)?.invocation, {
    kind: "action",
    id: "owner-action",
    runId: "original-run",
  });
  const trustedCopy = preserveCollectionInvocation({ ...first }, first);
  assertEquals(collectionReceiptInvocation(trustedCopy), expected);
  closeCollectionPolicyInvocation(first);
  assertThrows(
    () => collectionReceiptInvocation(first),
    Error,
    "authority has ended",
  );
  assertThrows(
    () => collectionReceiptInvocation(trustedCopy),
    Error,
    "authority has ended",
  );
});

Deno.test("ingress authority cannot mint a logical mutation receipt principal", () => {
  const viewer = bindOwnerCollectionInvocation({}, {
    scope: { databaseSchema: "public", namespace: "space" },
    signal: new AbortController().signal,
    resolveSource() {
      throw new Error("viewer has no Action source");
    },
  }, {
    kind: "processor",
    id: "collection:observe",
    runId: "request",
  });
  assertEquals(collectionReceiptInvocation(viewer), undefined);
  assertEquals(
    collectionReceiptInvocation(preserveCollectionInvocation({}, viewer)),
    undefined,
  );
});
