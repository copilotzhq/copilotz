import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type AuthenticatedAuthority,
  AUTHORITY_ADMISSION_MS,
  authorityDependsOn,
  credentialValidity,
  retainedAuthority,
} from "./authority.ts";

export function authorityFixture(): AuthenticatedAuthority {
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

Deno.test("retained authority round trips immutably with independent credential principal", () => {
  const input = authorityFixture();
  const authority = retainedAuthority(JSON.parse(JSON.stringify(input)));
  assertEquals(authority, input);
  assert(Object.isFrozen(authority));
  assert(Object.isFrozen(authority.requestFacts.input));
  assertEquals(authority.authorityBasis.id, "key-1");
  assertThrows(() =>
    retainedAuthority({
      ...input,
      authorityBasis: { kind: "credential", id: "creator" },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...input,
      principal: { ...input.principal, issuedBy: "creator" },
    })
  );
});

Deno.test("long-lived credentials admit for 15 minutes without revoking enrolled devices", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");
  assertEquals(
    Date.parse(credentialValidity(now).expiresAt) - now.getTime(),
    AUTHORITY_ADMISSION_MS,
  );
  assertEquals(
    credentialValidity(now, "2026-10-19T12:04:00.000Z").expiresAt,
    "2026-10-19T12:04:00.000Z",
  );
  assertThrows(() => credentialValidity(now, now.toISOString()));
  const device = {
    ...authorityFixture(),
    principal: { kind: "device" as const, id: "key-1" },
  };
  assertEquals(retainedAuthority(device).principal.kind, "device");
  assertThrows(() =>
    retainedAuthority({
      ...device,
      validity: {
        kind: "credential",
        admittedAt: now.toISOString(),
        expiresAt: "2026-10-19T12:15:00.001Z",
      },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...device,
      validity: {
        kind: "credential",
        admittedAt: now.toISOString(),
        expiresAt: null,
      },
    })
  );
});

Deno.test("delegated authority retains both identities and has attempt validity without expiry", () => {
  const delegated: AuthenticatedAuthority = {
    ...authorityFixture(),
    principal: {
      kind: "worker",
      id: "worker-1",
      executing: "agent-1",
      initiating: "agent-2",
    },
    validity: {
      kind: "attempt",
      attempt: "attempt-1",
      epoch: "2",
      worker: "worker-1",
    },
    requestFacts: { ...authorityFixture().requestFacts, transport: "worker" },
    provenance: { ingress: "worker", source: "event-1", parent: "parent-1" },
    authorityBasis: { kind: "attempt", id: "attempt-1" },
  };
  assertEquals(retainedAuthority(delegated), delegated);
  assertThrows(() =>
    retainedAuthority({
      ...delegated,
      validity: {
        ...delegated.validity,
        expiresAt: "2026-10-19T12:15:00.000Z",
      },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...delegated,
      principal: { kind: "worker", id: "worker-1", executing: "agent-1" },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...delegated,
      authorityBasis: { kind: "attempt", id: "attempt-2" },
    })
  );
});

Deno.test("authority rejects mixed provenance, cross-owner dependencies and executable facts", () => {
  const value = authorityFixture();
  assertThrows(() =>
    retainedAuthority({
      ...value,
      provenance: { ingress: "core", source: "event-1" },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...value,
      dependencies: [{ ...value.dependencies[0], owner: "other-owner" }],
    })
  );
  assertEquals(
    retainedAuthority({
      ...value,
      dependencies: [{ ...value.dependencies[0], namespace: "shared" }],
    }).dependencies[0].namespace,
    "shared",
  );
  assertThrows(() =>
    retainedAuthority({
      ...value,
      requestFacts: {
        ...value.requestFacts,
        request: new Request("https://example.invalid"),
      },
    })
  );
  assertThrows(() =>
    retainedAuthority({
      ...value,
      requestFacts: { ...value.requestFacts, input: "a".repeat(65536) },
    })
  );
  let accessed = false;
  assertThrows(() =>
    retainedAuthority({
      ...value,
      get requestFacts() {
        accessed = true;
        return value.requestFacts;
      },
    })
  );
  assertEquals(accessed, false);
});

Deno.test("point and set dependencies include missing-row and empty-query insertions", () => {
  const set = { owner: "schema", namespace: "main", collection: "membership" };
  assert(authorityDependsOn(set, { ...set, id: "new-row" }));
  assert(
    authorityDependsOn({ ...set, id: "missing-row" }, {
      ...set,
      id: "missing-row",
    }),
  );
  assert(
    !authorityDependsOn({ ...set, id: "missing-row" }, {
      ...set,
      id: "unrelated-row",
    }),
  );
  assert(!authorityDependsOn(set, { ...set, namespace: "other" }));
  assert(!authorityDependsOn(set, { ...set, owner: "other" }));
});

Deno.test("retained authority reuses only its validated immutable output", () => {
  const input = authorityFixture();
  const captured = retainedAuthority(input);
  assert(retainedAuthority(captured) === captured);
  assert(retainedAuthority(input) !== captured);
  assertThrows(() =>
    retainedAuthority(Object.freeze({ ...captured, version: 2 }))
  );
  assertThrows(() =>
    retainedAuthority({
      ...captured,
      principal: { ...captured.principal, id: "" },
    })
  );
});
