/** Delivery work can contain nested LLM calls, frame drains and finalization.
 * Lease renewal remains independent of this bounded execution deadline. */
export const DELIVERY_DEADLINE_MS = 15 * 60_000;
