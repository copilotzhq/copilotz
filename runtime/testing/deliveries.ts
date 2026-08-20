import type { DeliveryStatus, EventDelivery } from "../events/index.ts";

export async function waitForTestDelivery(
  host: Readonly<{
    deliveries: Readonly<{
      list(options: {
        namespace: string;
        eventId?: string;
        limit?: number;
      }): Promise<readonly EventDelivery[]>;
    }>;
  }>,
  namespace: string,
  eventId: string,
  status: DeliveryStatus,
  timeoutMs = 2_000,
): Promise<EventDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const delivery = (await host.deliveries.list({
      namespace,
      eventId,
      limit: 100,
    })).find((item) => item.status === status);
    if (delivery) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Delivery for '${eventId}' did not reach '${status}'.`);
}
