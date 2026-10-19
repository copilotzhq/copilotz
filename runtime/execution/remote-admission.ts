/** Trusted placement evidence for admission; no worker-supplied value registers it. */
import type { Hypervisor } from "../../dependencies/oxian-hypervisor.ts";
import type { DeliveryDispatcher, OwnerSessionSource } from "./types.ts";

type Session = ReturnType<Hypervisor["sessions"]["assertCurrent"]>;
export type RemoteFence = Pick<
  Session,
  "identity" | "connectionId" | "sessionGeneration"
>;
const placements = new WeakMap<DeliveryDispatcher, {
  select(workload: string, workerId?: string): Session | undefined;
  check(fence: RemoteFence): void;
}>();

export function remoteSessionKey(fence: RemoteFence): string {
  return encodeURIComponent(JSON.stringify([
    fence.identity.workerId,
    fence.identity.attemptId,
    fence.identity.epoch,
    fence.connectionId,
    fence.sessionGeneration,
  ]));
}

export function remoteClaimSession(owner: string): RemoteFence | undefined {
  const encoded = owner.split(":remote:")[1]?.split(":")[0];
  if (!encoded) return;
  try {
    const [workerId, attemptId, epoch, connectionId, sessionGeneration] = JSON
      .parse(decodeURIComponent(encoded));
    return {
      identity: { workerId, attemptId, epoch },
      connectionId,
      sessionGeneration,
    };
  } catch {
    return;
  }
}

export function registerRemoteAdmission(
  dispatcher: DeliveryDispatcher,
  source: OwnerSessionSource,
): () => void {
  const current = new Map<string, Session>();
  const remember = (session: Session) => {
    if (["closed", "expired", "drained"].includes(session.phase)) {
      current.delete(session.identity.workerId);
    } else current.set(session.identity.workerId, session);
  };
  const unsubscribe = source.subscribe!(remember);
  for (const session of source.list?.() ?? []) remember(session);
  const placement = {
    select(workload: string, workerId?: string) {
      return [...current.values()].filter((session) => {
        try {
          const live = source.assertCurrent(session);
          return live.phase === "ready" && live.reserved < live.capacity &&
            live.workloads.includes(workload) &&
            (!workerId || live.identity.workerId === workerId);
        } catch {
          return false;
        }
      }).sort((a, b) => a.reserved / a.capacity - b.reserved / b.capacity)[0];
    },
    check(fence: RemoteFence) {
      source.assertCurrent(fence);
    },
  };
  placements.set(dispatcher, placement);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    current.clear();
    if (placements.get(dispatcher) === placement) placements.delete(dispatcher);
    unsubscribe();
  };
}

export function prepareRemoteAdmission(
  dispatcher: DeliveryDispatcher,
  workload: string,
  workerId?: string,
) {
  const placement = placements.get(dispatcher);
  const session = placement?.select(workload, workerId);
  if (!session) return;
  const owner = `remote:${remoteSessionKey(session)}:${crypto.randomUUID()}`;
  // Dispatch metadata has a bounded attempt ID, including the owner prefix.
  if (owner.length > 700) return;
  return {
    consumerId: "processor:copilotz.server.action-request",
    owner,
    leaseMs: 120_000,
    assertCurrent: () => placement!.check(session),
  };
}
