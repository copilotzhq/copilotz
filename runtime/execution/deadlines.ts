/** Safety backstop only. Worker leases and provider inactivity detect liveness. */
export const DELIVERY_DEADLINE_MS = 6 * 60 * 60_000;

/** Timer values must fit the signed 32-bit timers used by every transport. */
export function validateDeliveryTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new RangeError(
      "deliveryTimeoutMs must be a positive timer-safe integer.",
    );
  }
  return value;
}

/**
 * A transport is configured before a nested Action is known. Reserve enough
 * time for every registered Action on both peers, including parent deliveries.
 * This is a safety ceiling, not an Action execution SLA.
 */
export function resolveDeliveryTimeoutMs(
  configured?: number,
  actions: Readonly<Record<string, { deliveryTimeoutMs?: number }>> = {},
): number {
  let timeout = validateDeliveryTimeoutMs(configured ?? DELIVERY_DEADLINE_MS);
  for (const action of Object.values(actions)) {
    if (action.deliveryTimeoutMs !== undefined) {
      timeout = Math.max(
        timeout,
        validateDeliveryTimeoutMs(action.deliveryTimeoutMs),
      );
    }
  }
  return timeout;
}
