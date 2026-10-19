/** Package-private admission evidence. No wire value can create this authority. */
import { captureHostCommandJson } from "../host-command-json.ts";
import { durableActionMetadata, sameActionValue } from "../../actions/value.ts";
import type { ProtectedActionIngress } from "../../actions/protected-action-types.ts";
import { digestContent } from "../../content/digest.ts";
import type { EventMutationContext } from "../../events/store.ts";

const proofs = new WeakMap<object, ProtectedActionIngress>();
export type OwnerIngressProof = Readonly<{ readonly __ownerIngress: never }>;
function proof(ingress: ProtectedActionIngress): OwnerIngressProof {
  const token = Object.freeze({}) as OwnerIngressProof;
  proofs.set(token, captureHostCommandJson(ingress) as ProtectedActionIngress);
  return token;
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
function evidence(
  token?: OwnerIngressProof,
): ProtectedActionIngress | undefined {
  if (!token) return;
  const value = proofs.get(token);
  if (!value) throw new Error("Owner ingress authority is invalid.");
  return value;
}
type EventBinding = Readonly<{
  id: string;
  namespace: string;
  type: string;
  payload: unknown;
  metadata?: Readonly<Record<string, unknown>>;
}>;
const key = (event: EventBinding) =>
  JSON.stringify(["owner.ingress", event.namespace, event.id]);
async function binding(
  databaseSchema: string,
  event: EventBinding,
  body: unknown,
) {
  return {
    databaseSchema,
    namespace: event.namespace,
    eventId: event.id,
    digest: await digestContent(
      new TextEncoder().encode(JSON.stringify(durableActionMetadata({
        type: event.type,
        payload: event.payload,
        metadata: event.metadata ?? {},
        body,
      }))),
    ),
  };
}
export async function recordOwnerIngress(
  context: EventMutationContext,
  databaseSchema: string,
  event: EventBinding,
  body: unknown,
  token?: OwnerIngressProof,
): Promise<void> {
  const ingress = evidence(token);
  if (!ingress) return;
  await context.transaction.query(
    `INSERT INTO ${context.tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','owner.ingress',$2::jsonb,$3::jsonb)`,
    [
      key(event),
      JSON.stringify(await binding(databaseSchema, event, body)),
      JSON.stringify({ ingress }),
    ],
  );
}
export async function resolveOwnerIngress(
  context: EventMutationContext,
  databaseSchema: string,
  event: EventBinding,
  body: unknown,
): Promise<ProtectedActionIngress | undefined> {
  const row = (await context.transaction.query<
    { intent: unknown; result: { ingress: ProtectedActionIngress } }
  >(
    `SELECT intent,result FROM ${context.tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind='owner.ingress' AND key=$1`,
    [key(event)],
  )).rows[0];
  if (!row) return;
  if (
    !sameActionValue(row.intent, await binding(databaseSchema, event, body))
  ) {
    throw new Error("Owner ingress binding is invalid.");
  }
  return captureHostCommandJson(row.result.ingress) as ProtectedActionIngress;
}
export async function assertOwnerIngressReplay(
  context: EventMutationContext,
  databaseSchema: string,
  event: EventBinding,
  body: unknown,
  token?: OwnerIngressProof,
): Promise<void> {
  const expected = evidence(token);
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
