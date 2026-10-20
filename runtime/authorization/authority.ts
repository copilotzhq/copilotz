/** Retained data describes authority; only owner admission can mint a capability. */
import { captureHostCommandJson } from "../application/host-command-json.ts";

export const AUTHORITY_ADMISSION_MS = 15 * 60 * 1000;
export type AuthorityScope = Readonly<{
  owner: string;
  databaseSchema: string;
  tenant: string;
  namespace: string;
  bindings: Readonly<Record<string, string>>;
}>;
export type AuthorityPrincipal = Readonly<{
  kind:
    | "session"
    | "api-key"
    | "device"
    | "system"
    | "grant"
    | "channel"
    | "service"
    | "worker"
    | "host-task";
  id: string;
  executing?: string;
  initiating?: string;
}>;
export type AuthorityPolicy = Readonly<{ id: string; revision: string }>;
export type AuthorityDependency = Readonly<{
  owner: string;
  namespace: string;
  collection: string;
  /** Omission means the entire set, including insertions into an empty set. */
  id?: string;
  /** Null records a negative point lookup; queries can retain a source revision. */
  revision?: string | null;
}>;
export type AuthorityValidity =
  | Readonly<{ kind: "credential"; admittedAt: string; expiresAt: string }>
  | Readonly<{
    kind: "attempt";
    attempt: string;
    epoch: string;
    worker: string;
  }>
  | Readonly<{ kind: "occurrence"; key: string; revision: string }>;
export type AuthenticatedAuthority = Readonly<{
  flow?: Readonly<
    { id: string; kind: string; continuation: string; expiresAt: string }
  >;
  version: 1;
  principal: AuthorityPrincipal;
  scope: AuthorityScope;
  validity: AuthorityValidity;
  policy: AuthorityPolicy;
  requestFacts: Readonly<{
    endpoint: string;
    transport: "http" | "websocket" | "core" | "worker" | "alarm";
    operation: string;
    params: Readonly<Record<string, string>>;
    input: import("../application/host-command-types.ts").HostCommandJson;
  }>;
  provenance: Readonly<{
    ingress: "http" | "core" | "channel" | "worker" | "alarm";
    source: string;
    parent?: string;
  }>;
  dependencies: readonly AuthorityDependency[];
  /** Attribution (creator/initiator) is deliberately separate from this grant. */
  authorityBasis: Readonly<{
    kind: "session" | "credential" | "grant" | "attempt" | "occurrence";
    id: string;
  }>;
}>;

function invalid(message: string): never {
  throw new TypeError(`Invalid retained authority: ${message}.`);
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected an object");
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalid("unexpected field");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    invalid("expected bounded nonempty text");
  }
}
function strings(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected string map");
  }
  for (const [key, item] of Object.entries(value)) {
    text(key);
    if (typeof item !== "string" || item.length > 4096) {
      invalid("invalid map value");
    }
  }
}
function timestamp(value: unknown): number {
  text(value);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    invalid("expected canonical timestamp");
  }
  return time;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Validates persisted/wire data without granting permission to use it. */
export function retainedAuthority(value: unknown): AuthenticatedAuthority {
  const captured = captureHostCommandJson(value);
  if (new TextEncoder().encode(JSON.stringify(captured)).length > 65536) {
    invalid("binding exceeds 64 KiB");
  }
  const root = object(captured, [
    "flow",
    "version",
    "principal",
    "scope",
    "validity",
    "policy",
    "requestFacts",
    "provenance",
    "dependencies",
    "authorityBasis",
  ]);
  if (root.version !== 1) invalid("unsupported version");
  if (root.flow !== undefined) {
    const flow = object(root.flow, ["id", "kind", "continuation", "expiresAt"]);
    for (const key of ["id", "kind", "continuation"]) text(flow[key]);
    timestamp(flow.expiresAt);
  }
  const principal = object(root.principal, [
    "kind",
    "id",
    "executing",
    "initiating",
  ]);
  if (
    ![
      "session",
      "api-key",
      "device",
      "system",
      "grant",
      "channel",
      "service",
      "worker",
      "host-task",
    ].includes(String(principal.kind))
  ) invalid("principal kind");
  text(principal.id);
  for (const key of ["executing", "initiating"]) {
    if (principal[key] !== undefined) text(principal[key]);
  }
  const scope = object(root.scope, [
    "owner",
    "databaseSchema",
    "tenant",
    "namespace",
    "bindings",
  ]);
  for (const key of ["owner", "databaseSchema", "tenant", "namespace"]) {
    text(scope[key]);
  }
  if (scope.owner !== "schema") invalid("unsupported owner");
  strings(scope.bindings);
  const policy = object(root.policy, ["id", "revision"]);
  text(policy.id);
  text(policy.revision);
  const validity = object(root.validity, [
    "kind",
    "admittedAt",
    "expiresAt",
    "attempt",
    "epoch",
    "worker",
    "key",
    "revision",
  ]);
  if (validity.kind === "credential") {
    object(validity, ["kind", "admittedAt", "expiresAt"]);
    const start = timestamp(validity.admittedAt);
    const end = timestamp(validity.expiresAt);
    if (end <= start) invalid("empty lifetime");
    if (
      ["api-key", "device"].includes(String(principal.kind)) &&
      end - start > AUTHORITY_ADMISSION_MS
    ) invalid("credential admission exceeds 15 minutes");
    if (["worker", "host-task"].includes(String(principal.kind))) {
      invalid("delegation cannot use credential expiry");
    }
  } else if (validity.kind === "attempt") {
    object(validity, ["kind", "attempt", "epoch", "worker"]);
    for (const key of ["attempt", "epoch", "worker"]) text(validity[key]);
    if (principal.kind !== "worker" || validity.worker !== principal.id) {
      invalid("attempt requires worker identity");
    }
    text(principal.executing);
    text(principal.initiating);
  } else if (validity.kind === "occurrence") {
    object(validity, ["kind", "key", "revision"]);
    text(validity.key);
    text(validity.revision);
    if (principal.kind !== "host-task") {
      invalid("occurrence requires host task");
    }
  } else invalid("validity kind");
  const facts = object(root.requestFacts, [
    "endpoint",
    "transport",
    "operation",
    "params",
    "input",
  ]);
  text(facts.endpoint);
  text(facts.operation);
  strings(facts.params);
  if (
    !["http", "websocket", "core", "worker", "alarm"].includes(
      String(facts.transport),
    )
  ) invalid("transport");
  if (!Object.hasOwn(facts, "input")) invalid("missing input facts");
  const provenance = object(root.provenance, ["ingress", "source", "parent"]);
  text(provenance.source);
  if (provenance.parent !== undefined) text(provenance.parent);
  if (
    !["http", "core", "channel", "worker", "alarm"].includes(
      String(provenance.ingress),
    )
  ) invalid("ingress");
  if (
    (facts.transport === "http" || facts.transport === "websocket") &&
    !["http", "channel"].includes(String(provenance.ingress))
  ) invalid("mixed client and internal provenance");
  if (facts.transport === "core" && provenance.ingress !== "core") {
    invalid("mixed Core provenance");
  }
  if (
    facts.transport === "worker" &&
    (provenance.ingress !== "worker" || validity.kind !== "attempt")
  ) invalid("worker provenance");
  if (
    facts.transport === "alarm" &&
    (provenance.ingress !== "alarm" || validity.kind !== "occurrence")
  ) invalid("alarm provenance");
  if (!Array.isArray(root.dependencies) || root.dependencies.length > 256) {
    invalid("dependencies");
  }
  for (const item of root.dependencies) {
    const dependency = object(item, [
      "owner",
      "namespace",
      "collection",
      "id",
      "revision",
    ]);
    for (const key of ["owner", "namespace", "collection"]) {
      text(dependency[key]);
    }
    if (dependency.id !== undefined) text(dependency.id);
    if (dependency.revision !== undefined && dependency.revision !== null) {
      text(dependency.revision);
    }
    if (
      dependency.owner !== scope.owner
    ) invalid("nonlocal policy dependency");
  }
  const basis = object(root.authorityBasis, ["kind", "id"]);
  text(basis.id);
  const expected = validity.kind === "attempt"
    ? "attempt"
    : validity.kind === "occurrence"
    ? "occurrence"
    : principal.kind === "session"
    ? "session"
    : principal.kind === "grant"
    ? "grant"
    : "credential";
  if (basis.kind !== expected) invalid("authority basis differs from validity");
  if (basis.kind === "attempt" && basis.id !== validity.attempt) {
    invalid("attempt basis");
  }
  if (basis.kind === "occurrence" && basis.id !== validity.key) {
    invalid("occurrence basis");
  }
  if (
    ["credential", "grant"].includes(String(basis.kind)) &&
    basis.id !== principal.id
  ) invalid("credential basis cannot be its creator");
  if (
    root.flow &&
    (principal.kind !== "grant" ||
      (root.flow as Record<string, unknown>).id !== principal.id)
  ) invalid("flow principal");
  return freeze(captured as AuthenticatedAuthority);
}

/** A long-lived device remains enrolled; only this admission is short-lived. */
export function credentialValidity(
  now: Date,
  credentialExpiresAt?: string,
): Extract<AuthorityValidity, { kind: "credential" }> {
  const start = now.getTime();
  if (!Number.isFinite(start)) invalid("admission time");
  const end = Math.min(
    start + AUTHORITY_ADMISSION_MS,
    credentialExpiresAt === undefined
      ? Infinity
      : timestamp(credentialExpiresAt),
  );
  if (end <= start) invalid("credential expired");
  return Object.freeze({
    kind: "credential",
    admittedAt: now.toISOString(),
    expiresAt: new Date(end).toISOString(),
  });
}

export function authorityDependsOn(
  dependency: AuthorityDependency,
  change: AuthorityDependency,
): boolean {
  return dependency.owner === change.owner &&
    dependency.namespace === change.namespace &&
    dependency.collection === change.collection &&
    (dependency.id === undefined || change.id === undefined ||
      dependency.id === change.id);
}
