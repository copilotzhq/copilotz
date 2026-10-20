import type { DatabaseOwner } from "../engine/commands.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { completeOwnerDeadline } from "../engine/alarms.ts";
import type { EventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "./types.ts";

/** One owner source covers availability, retry backoff and remote lease expiry. */
export function registerDeliveryAlarms(
  owner: DatabaseOwner,
  store: EventStore,
  executor: DeliveryExecutor,
): () => void {
  const run = createSchemaCommandRunner(store.session, store.databaseSchema);
  return owner.registerAlarmSource({
    name: "deliveries",
    async wake(deadlines) {
      await run("alarm.deliveries.consume", {}, async (_input, context) => {
        for (const deadline of deadlines) {
          await completeOwnerDeadline(
            context.transaction,
            store.databaseSchema,
            deadline,
          );
        }
      });
      for (
        const namespace of new Set(
          deadlines.map((deadline) => deadline.namespace),
        )
      ) {
        if (namespace === null) {
          throw new Error("Delivery alarm has no namespace.");
        }
        await store.recoverExpiredDeliveries({ namespace, limit: 1000 });
      }
      for (const deadline of deadlines) {
        const delivery = await store.getDelivery(deadline.key);
        if (
          delivery &&
          ["pending", "retry_wait", "leased"].includes(delivery.status)
        ) executor.scheduleDelivery(delivery);
      }
    },
  });
}
