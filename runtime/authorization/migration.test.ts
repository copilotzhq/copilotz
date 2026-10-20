import { assertEquals, assertRejects } from "@std/assert";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "./authority.ts";
import {
  planAuthorityMigration,
  type RetainedInvocation,
  retainedInvocationDigest,
} from "./migration.ts";

function authorityFixture(): AuthenticatedAuthority {
  return {
    version: 1,
    principal: { kind: "api-key", id: "key-1" },
    scope: {
      owner: "schema",
      databaseSchema: "app",
      tenant: "scope-1",
      namespace: "main",
      bindings: { space: "space-1" },
    },
    validity: credentialValidity(new Date("2026-10-19T12:00:00.000Z")),
    policy: { id: "application", revision: "2" },
    requestFacts: {
      endpoint: "action:run",
      transport: "http",
      operation: "invoke",
      params: {},
      input: { message: "hello" },
    },
    provenance: { ingress: "http", source: "event-1" },
    dependencies: [{
      owner: "schema",
      namespace: "main",
      collection: "credential",
      id: "key-1",
    }],
    authorityBasis: { kind: "credential", id: "key-1" },
  };
}

function invocation(): RetainedInvocation {
  return {
    databaseSchema: "app",
    namespace: "main",
    runId: "run-1",
    actionId: "action-1",
    sourceEventId: "event-1",
    operationId: "operation-1",
    parentRunId: null,
    body: {
      status: "invoked",
      actionId: "action-1",
      actionRunId: "run-1",
      input: { text: "captured", revision: "1" },
    },
    capture: {
      intent: {
        databaseSchema: "app",
        namespace: "main",
        actionId: "action-1",
        inputSchema: { type: "object" },
        publicRevisionFields: ["/revision"],
      },
      result: {
        source: { eventId: "event-1", operationId: "operation-1" },
        request: { text: "captured" },
      },
    },
  };
}
async function entry(value = invocation()) {
  return {
    databaseSchema: value.databaseSchema,
    namespace: value.namespace,
    runId: value.runId,
    expectedDigest: await retainedInvocationDigest(value),
    authority: authorityFixture(),
  };
}
const policies = [{ id: "application", revision: "2" }];

Deno.test("authority migration retains first capture and receipt identity without preparation", async () => {
  const source = invocation();
  const before = JSON.stringify(source);
  const plan = await planAuthorityMigration(
    [source],
    [await entry()],
    policies,
  );
  assertEquals(plan[0].capture, source.capture);
  assertEquals(plan[0].authority, authorityFixture());
  assertEquals(JSON.stringify(source), before);
  assertEquals(
    await planAuthorityMigration([source], [await entry()], policies),
    plan,
  );
});

Deno.test("authority migration refuses missing, duplicate, dangling and stale inventory entries", async () => {
  const value = invocation();
  const manifest = await entry();
  await assertRejects(
    () => planAuthorityMigration([value], [], policies),
    TypeError,
    "no explicit",
  );
  await assertRejects(
    () => planAuthorityMigration([value], [manifest, manifest], policies),
    TypeError,
    "Duplicate",
  );
  await assertRejects(
    () => planAuthorityMigration([value, value], [manifest], policies),
    TypeError,
    "Duplicate",
  );
  await assertRejects(
    () => planAuthorityMigration([], [manifest], policies),
    TypeError,
    "unknown retained",
  );
  const changed = {
    ...value,
    body: { ...(value.body as object), input: { text: "reprepared" } },
  };
  await assertRejects(
    () => planAuthorityMigration([changed], [manifest], policies),
    TypeError,
    "changed after inventory",
  );
  const revisionChanged = {
    ...value,
    capture: {
      ...value.capture!,
      intent: { ...value.capture!.intent, publicRevisionFields: [] },
    },
  };
  await assertRejects(
    () => planAuthorityMigration([revisionChanged], [manifest], policies),
    TypeError,
    "changed after inventory",
  );
});

Deno.test("migration fails closed on unknown policy revisions and scope/provenance rewrites", async () => {
  const value = invocation();
  const manifest = await entry();
  await assertRejects(
    () => planAuthorityMigration([value], [manifest], []),
    TypeError,
    "unknown policy",
  );
  for (
    const authority of [
      {
        ...manifest.authority,
        scope: { ...manifest.authority.scope, databaseSchema: "other" },
      },
      {
        ...manifest.authority,
        provenance: { ...manifest.authority.provenance, source: "other-event" },
      },
      {
        ...manifest.authority,
        provenance: { ...manifest.authority.provenance, parent: "new-parent" },
      },
    ]
  ) {
    await assertRejects(
      () =>
        planAuthorityMigration([value], [{ ...manifest, authority }], policies),
      TypeError,
      "differs from retained provenance",
    );
  }
});

Deno.test("migration refuses an inconsistent protected capture source or lifecycle", async () => {
  const value = invocation();
  await assertRejects(
    () =>
      retainedInvocationDigest({
        ...value,
        capture: {
          ...value.capture!,
          result: {
            ...value.capture!.result,
            source: { eventId: "wrong-source" },
          },
        },
      }),
    TypeError,
    "inconsistent",
  );
  await assertRejects(
    () =>
      retainedInvocationDigest({
        ...value,
        body: { ...(value.body as object), actionRunId: "another-run" },
      }),
    TypeError,
    "does not match",
  );
});

Deno.test("authority migration preserves protected references and detects ciphertext substitution", async () => {
  const raw = invocation();
  const value: RetainedInvocation = {
    ...raw,
    body: {
      schema: "copilotz.action.lifecycle.protected.v1",
      data: raw.body,
      protected: {
        input: {
          schema: "copilotz.action.protected-value.v1",
          ownerNodeId: "protected-1",
          bodyId: "body-1",
          byteLength: 64,
          digest: `sha256:${"a".repeat(64)}`,
          mediaType: "application/vnd.copilotz.action-protected-value+json",
          commitment: "captured-commitment",
          envelope: { key: "encryption-key-1", nonce: "captured-nonce" },
        },
      },
    },
  };
  const before = JSON.stringify(value);
  const manifest = await entry(value);
  await planAuthorityMigration([value], [manifest], policies);
  assertEquals(JSON.stringify(value), before);
  const changed = JSON.parse(before);
  changed.body.protected.input.bodyId = "body-2";
  await assertRejects(
    () => planAuthorityMigration([changed], [manifest], policies),
    TypeError,
    "changed after inventory",
  );
  const malformed = JSON.parse(before);
  malformed.body.protected.input.digest = "not-a-digest";
  await assertRejects(() => retainedInvocationDigest(malformed), TypeError);
});
