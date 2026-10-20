import { schemaCommandContext } from "../../engine/commands.ts";
import { authorizationRefused } from "../../authorization/evaluator.ts";
import { captureCollectionInvocation } from "../../authorization/invocation.ts";
/** Package-private admission evidence. No wire value can create this authority. */
import { captureHostCommandJson } from "../host-command-json.ts";
import { sameActionValue } from "../../actions/value.ts";
import type { ProtectedActionIngress } from "../../actions/protected-action-types.ts";
import type { EventMutationContext } from "../../events/store.ts";

const provenance = Symbol("owner-ingress");
export type OwnerIngressProof = Readonly<
  { [provenance]: ProtectedActionIngress }
>;
function proof(ingress: ProtectedActionIngress): OwnerIngressProof {
  return {
    [provenance]: captureHostCommandJson(ingress) as ProtectedActionIngress,
  };
}
export const hostIngressProof = (): OwnerIngressProof => {
  const invocation = captureCollectionInvocation();
  const authority = invocation?.authority;
  if (invocation && !invocation.trustedHost && !authority) {
    authorizationRefused();
  }
  return proof({ kind: "host", ...(authority ? { authority } : {}) });
};
export const authenticatedServerIngressProof = (
  actor: Extract<
    ProtectedActionIngress,
    { kind: "authenticated-server" }
  >["actor"],
): OwnerIngressProof => proof({ kind: "authenticated-server", actor });
export const serverRouteIngressProof = (routeId: string): OwnerIngressProof =>
  proof({ kind: "server-route", routeId });
export const scheduledOccurrenceIngressProof = (
  occurrence: Omit<
    Extract<ProtectedActionIngress, { kind: "scheduled-occurrence" }>,
    "kind"
  >,
): OwnerIngressProof => proof({ kind: "scheduled-occurrence", ...occurrence });
export function ownerIngressEvidence(
  token?: OwnerIngressProof,
): ProtectedActionIngress | undefined {
  if (!token) return;
  const value = token[provenance];
  if (!value) throw new Error("Owner ingress authority is invalid.");
  return value;
}
type EventBinding = Readonly<{
  id: string;
  namespace: string;
  type: string;
  payload: unknown;
  metadata?: Readonly<Record<string, unknown>>;
  ownerIngress?: ProtectedActionIngress;
}>;
/** The caller loads this field with the immutable accepted event. */
export function resolveOwnerIngress(
  _context: EventMutationContext,
  _databaseSchema: string,
  event: EventBinding,
  _body: unknown,
): Promise<ProtectedActionIngress | undefined> {
  return Promise.resolve(event.ownerIngress);
}
export async function assertOwnerIngressReplay(
  context: EventMutationContext,
  databaseSchema: string,
  event: EventBinding,
  body: unknown,
  token?: OwnerIngressProof,
): Promise<void> {
  const expected = ownerIngressEvidence(token);
  const actual = await resolveOwnerIngress(
    context,
    databaseSchema,
    event,
    body,
  );
  // The first admission is immutable. A stronger retry cannot upgrade an
  // originally unclassified event; duplicate body and metadata checks still apply.
  if (actual === undefined) return;
  const identity = (value: ProtectedActionIngress | undefined) => {
    if (!value?.authority) return value ?? null;
    const { requestMetadata: _requestMetadata, ...admission } = value;
    const { validity, dependencies: _dependencies, ...authority } =
      value.authority;
    // Renewal changes only admission time and tracked dependencies. First capture
    // remains immutable; attempt/occurrence identities must still match exactly.
    return {
      ...admission,
      authority: {
        ...authority,
        scope: {
          ...authority.scope,
          bindings: Object.fromEntries(
            Object.entries(authority.scope.bindings).filter(([key]) =>
              key !== "@credential-proof"
            ),
          ),
        },
        validity: validity.kind === "credential"
          ? { kind: "credential" }
          : validity,
      },
    };
  };
  if (!sameActionValue(identity(expected), identity(actual))) {
    if (
      await isCredentialOperationReplay(context, databaseSchema, event, token)
    ) return;
    throw Object.assign(
      new Error("Owner ingress admission differs from its first capture."),
      { code: "event_deduplication_conflict" },
    );
  }
}

export const authorityIngressProof = (
  authority: import("../../authorization/authority.ts").AuthenticatedAuthority,
): OwnerIngressProof =>
  proof({
    kind: "authenticated-server",
    actor: { id: authority.principal.id },
    authority,
  });

/** Exact completed credential recovery, never authority for inserting new work. */
export async function isCredentialOperationReplay(
  context: EventMutationContext,
  databaseSchema: string,
  event: EventBinding,
  token?: OwnerIngressProof,
): Promise<boolean> {
  const original = event.ownerIngress?.authority;
  const next = ownerIngressEvidence(token)?.authority;
  const proof = original?.scope.bindings["@credential-proof"];
  if (
    !original || !next || !proof ||
    proof !== next.scope.bindings["@credential-proof"] ||
    !sameActionValue(original.scope, next.scope) ||
    !sameActionValue(original.policy, next.policy)
  ) return false;
  const { commandTime } = schemaCommandContext(
    context.transaction,
    databaseSchema,
  );
  if (
    original.flow &&
    Date.parse(original.flow.expiresAt) <= Date.parse(commandTime)
  ) return false;
  const rows = await context.transaction.query<
    { method: string; claims: { id: string; principal: string } }
  >(
    `SELECT effect.method,effect.claims FROM "${databaseSchema}".authorization_effects effect JOIN "${databaseSchema}".copilotz_operations operation ON operation.namespace=effect.namespace AND operation.operation_id=effect.operation_id WHERE effect.namespace=$1 AND effect.tenant=$2 AND effect.operation_id=$3 AND operation.state='completed' AND ((effect.method IN ('flow.start','session.create') AND (effect.claims->>'expiresAt')::timestamptz>$4::timestamptz) OR (effect.method='session.revoke' AND effect.claims->>'id'=$5 AND $6::timestamptz>$4::timestamptz))`,
    [
      original.scope.namespace,
      original.scope.tenant,
      event.id,
      commandTime,
      original.authorityBasis.kind === "session"
        ? original.authorityBasis.id
        : "",
      original.validity.kind === "credential"
        ? original.validity.expiresAt
        : commandTime,
    ],
  );
  return rows.rows.some((row) =>
    sameActionValue(original.principal, next.principal) &&
      sameActionValue(original.authorityBasis, next.authorityBasis) ||
    row.method === "session.create" && next.authorityBasis.kind === "session" &&
      next.authorityBasis.id === row.claims.id &&
      next.principal.id === row.claims.principal ||
    row.method === "flow.start" && next.flow?.id === row.claims.id ||
    row.method === "session.revoke" &&
      original.authorityBasis.kind === "session" &&
      original.authorityBasis.id === row.claims.id &&
      next.authorityBasis.kind === "grant" && !next.flow
  );
}

/** Keep raw metadata separate from credential-dependent policy output. */
export function withIngressRequestMetadata(
  token: OwnerIngressProof | undefined,
  metadata: Readonly<Record<string, unknown>>,
): OwnerIngressProof | undefined {
  const ingress = ownerIngressEvidence(token);
  return ingress?.authority
    ? proof({ ...ingress, requestMetadata: metadata })
    : token;
}
