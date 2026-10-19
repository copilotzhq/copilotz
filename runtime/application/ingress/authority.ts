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
export const hostIngressProof = (): OwnerIngressProof =>
  proof({ kind: "host" });
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
  if (!sameActionValue(expected ?? null, actual)) {
    throw Object.assign(
      new Error("Owner ingress admission differs from its first capture."),
      { code: "event_deduplication_conflict" },
    );
  }
}
