import type { EventStore } from "../events/store.ts";
import type { CommandCaller, CommandIdentity } from "../engine/commands.ts";
import type { SqlSession } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";

export async function heartbeat(
  store: EventStore,
  input: { id: string; owner: string; leaseMs?: number },
) {
  const delivery = await store.getDelivery(input.id);
  if (!delivery) return false;
  const event = await store.getEvent(delivery.eventId);
  const authority = await store.executionAuthority();
  return (await store.heartbeatDeliveries([{
    ...input,
    leaseMs: Math.max(1, input.leaseMs ?? 120_000),
    ownerEpoch: authority.epoch,
    namespace: event!.namespace,
    eventId: delivery.eventId,
    operationId: "",
  }])).length === 1;
}
export async function claimFirst(
  store: EventStore,
  input: {
    owner: string;
    namespace?: string;
    consumerIds?: readonly string[];
    leaseMs?: number;
  },
) {
  for (const row of await store.listRecoverable(input)) {
    const claimed = await store.claimDelivery({
      id: row.id,
      owner: input.owner,
      leaseMs: input.leaseMs,
    });
    if (claimed) return claimed;
  }
  return null;
}
export async function receipt(
  session: SqlSession,
  schema: string,
  caller: CommandCaller,
  identity: CommandIdentity,
) {
  return (await session.query<{ result: unknown }>(
    `SELECT kind,intent,result FROM ${
      createCoreTableNames(schema).owner_receipts
    } WHERE owner='schema' AND domain=$1 AND key=$2 AND principal=$3`,
    [identity.domain, identity.key, caller.principal],
  )).rows[0];
}
