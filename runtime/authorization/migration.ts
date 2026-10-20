import { protectedActionLifecycleBody } from "../actions/protected-lifecycle.ts";
/** Offline, explicit binding migration. It never reconstructs a captured input. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { stableStringify } from "../collections/equal.ts";
import {
  type AuthenticatedAuthority,
  type AuthorityPolicy,
  retainedAuthority,
} from "./authority.ts";

export type RetainedInvocation = Readonly<{
  databaseSchema: string;
  namespace: string;
  runId: string;
  actionId: string;
  sourceEventId: string;
  operationId: string | null;
  parentRunId: string | null;
  /** The exact stored lifecycle body, including sealed input references. */
  body: unknown;
  /** The old preparation receipt is evidence, never permission to prepare again. */
  capture:
    | Readonly<{
      intent: Readonly<{
        databaseSchema: string;
        namespace: string;
        actionId: string;
        inputSchema: unknown;
        publicRevisionFields: readonly string[];
      }>;
      result: Readonly<{
        source: Readonly<{ eventId: string; operationId?: string }>;
        request: unknown;
      }>;
    }>
    | null;
}>;
export type AuthorityMigrationEntry = Readonly<{
  databaseSchema: string;
  namespace: string;
  runId: string;
  /** Digest produced by the reviewed inventory, covering body AND old receipt. */
  expectedDigest: string;
  authority: AuthenticatedAuthority;
}>;
export type MigratedInvocationAuthority = Readonly<{
  databaseSchema: string;
  namespace: string;
  runId: string;
  expectedDigest: string;
  authority: AuthenticatedAuthority;
  /** Archived capture identity accompanies the retained invocation unchanged. */
  capture: RetainedInvocation["capture"];
}>;

/** Pre-v13 review bindings identify the credential itself, never its creator. */
export function retainedMigrationAuthority(
  value: unknown,
): AuthenticatedAuthority {
  const authority = retainedAuthority(value);
  if (
    authority.authorityBasis.kind === "session" &&
    authority.authorityBasis.id !== authority.principal.id
  ) {
    throw new TypeError(
      "Invalid retained authority: credential basis cannot be its creator.",
    );
  }
  return authority;
}

function key(
  value: Pick<RetainedInvocation, "databaseSchema" | "namespace" | "runId">,
): string {
  for (const item of [value.databaseSchema, value.namespace, value.runId]) {
    if (typeof item !== "string" || !item) {
      throw new TypeError("Incomplete invocation coordinates.");
    }
  }
  return JSON.stringify([value.databaseSchema, value.namespace, value.runId]);
}
function validateInvocation(value: RetainedInvocation): RetainedInvocation {
  const snapshot = captureHostCommandJson(value) as RetainedInvocation;
  key(snapshot);
  for (const field of [snapshot.actionId, snapshot.sourceEventId]) {
    if (typeof field !== "string" || !field) {
      throw new TypeError("Incomplete retained invocation.");
    }
  }
  if (
    snapshot.operationId !== null &&
    (typeof snapshot.operationId !== "string" || !snapshot.operationId)
  ) {
    throw new TypeError("Invalid retained operation.");
  }
  if (
    snapshot.parentRunId !== null &&
    (typeof snapshot.parentRunId !== "string" || !snapshot.parentRunId)
  ) throw new TypeError("Invalid retained parent.");
  const wrapped = snapshot.body as Record<string, unknown> | null;
  const protectedBody = protectedActionLifecycleBody(snapshot.body);
  const data = (protectedBody?.data ?? wrapped) as
    | Record<string, unknown>
    | null;
  if (
    !data || data.status !== "invoked" || data.actionRunId !== snapshot.runId ||
    data.actionId !== snapshot.actionId ||
    (data.parentActionRunId ?? null) !== snapshot.parentRunId ||
    !Object.hasOwn(data, "input")
  ) throw new TypeError("Retained capture does not match its invocation.");
  if (snapshot.capture !== null) {
    const { intent, result } = snapshot.capture;
    if (
      !intent || !result || intent.databaseSchema !== snapshot.databaseSchema ||
      intent.namespace !== snapshot.namespace ||
      intent.actionId !== snapshot.actionId ||
      result.source?.eventId !== snapshot.sourceEventId ||
      (result.source?.operationId ?? null) !== snapshot.operationId ||
      !Object.hasOwn(intent, "inputSchema") ||
      !Object.hasOwn(result, "request") ||
      !Array.isArray(intent.publicRevisionFields) ||
      intent.publicRevisionFields.some((path) =>
        typeof path !== "string" || !path.startsWith("/")
      )
    ) throw new TypeError("Protected capture binding is inconsistent.");
  }
  return snapshot;
}

export async function retainedInvocationDigest(
  value: RetainedInvocation,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    stableStringify(validateInvocation(value)),
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Requires a reviewed entry for every invocation. An executor must compare these
 * digests again in its owner transaction before replacing any capture receipt.
 * Planning neither mutates history nor installs runtime authorization.
 */
export async function planAuthorityMigration(
  inventory: readonly RetainedInvocation[],
  manifest: readonly AuthorityMigrationEntry[],
  knownPolicies: readonly AuthorityPolicy[],
): Promise<readonly MigratedInvocationAuthority[]> {
  const policies = new Set(
    knownPolicies.map((policy) => JSON.stringify([policy.id, policy.revision])),
  );
  const entries = new Map<string, AuthorityMigrationEntry>();
  for (const entry of manifest) {
    const identity = key(entry);
    if (entries.has(identity)) {
      throw new TypeError("Duplicate authority migration entry.");
    }
    entries.set(
      identity,
      captureHostCommandJson(entry) as AuthorityMigrationEntry,
    );
  }
  const seen = new Set<string>();
  const plan: MigratedInvocationAuthority[] = [];
  for (const raw of inventory) {
    const invocation = validateInvocation(raw);
    const identity = key(invocation);
    if (seen.has(identity)) {
      throw new TypeError("Duplicate retained invocation.");
    }
    seen.add(identity);
    const entry = entries.get(identity);
    if (!entry) {
      throw new TypeError("Retained work has no explicit authority migration.");
    }
    const digest = await retainedInvocationDigest(invocation);
    if (entry.expectedDigest !== digest) {
      throw new TypeError("Retained capture changed after inventory.");
    }
    const authority = retainedMigrationAuthority(entry.authority);
    if (
      authority.scope.databaseSchema !== invocation.databaseSchema ||
      authority.scope.namespace !== invocation.namespace ||
      authority.provenance.source !== invocation.sourceEventId ||
      (authority.provenance.parent ?? null) !== invocation.parentRunId
    ) {
      throw new TypeError(
        "Migration authority differs from retained provenance.",
      );
    }
    if (
      !policies.has(
        JSON.stringify([authority.policy.id, authority.policy.revision]),
      )
    ) throw new TypeError("Migration references an unknown policy revision.");
    // Expired authority is retained faithfully. Migration is not renewal.
    plan.push({
      databaseSchema: invocation.databaseSchema,
      namespace: invocation.namespace,
      runId: invocation.runId,
      expectedDigest: digest,
      authority,
      capture: invocation.capture,
    });
  }
  if (seen.size !== entries.size) {
    throw new TypeError("Authority manifest names unknown retained work.");
  }
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(plan);
}
