import type {
  ActiveMutableBodyHead,
  BodyHead,
  BodyStore,
  MutableBodyHead,
} from "./body-store.ts";

export type ProgressiveBodyMaintenanceError = Readonly<{
  bodyId: string;
  message: string;
}>;

/** Result of domain-neutral recovery for expired progressive Body writers. */
export type ProgressiveBodyMaintenanceResult = Readonly<{
  examined: number;
  aborted: number;
  deferred: number;
  errors: readonly ProgressiveBodyMaintenanceError[];
}>;

export const EMPTY_PROGRESSIVE_BODY_MAINTENANCE:
  ProgressiveBodyMaintenanceResult = Object.freeze({
    examined: 0,
    aborted: 0,
    deferred: 0,
    errors: Object.freeze([]),
  });

function isActive(
  head: BodyHead | MutableBodyHead,
): head is ActiveMutableBodyHead {
  return head.state === "open" || head.state === "sealing";
}

/**
 * Fences and aborts progressive Bodies whose writer lease has expired.
 *
 * This is deliberately ignorant of the semantic owner of a Body. A live body
 * renews its lease by appending or sealing; an expired body is safe to take
 * over and abort. Ready-body collection stays with Asset/orphan maintenance.
 */
export async function maintainProgressiveBodies(
  store: BodyStore,
  input: Readonly<{ limit?: number }> = {},
): Promise<ProgressiveBodyMaintenanceResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError("Progressive body maintenance limit must be 1..10000.");
  }
  const page = await store.maintenance.list({
    states: ["open", "sealing"],
    idleForMs: 0,
    limit,
  });
  let examined = 0;
  let aborted = 0;
  let deferred = 0;
  const errors: ProgressiveBodyMaintenanceError[] = [];
  for (const body of page.bodies) {
    if (!isActive(body)) continue;
    examined++;
    if (body.writerLeaseRemainingMs > 0) {
      deferred++;
      continue;
    }
    try {
      // The reserve generation is the cross-process fence. Only the winner
      // may abort this expired operational body.
      const writer = await store.reserve({
        bodyId: body.bodyId,
        mediaType: body.mediaType,
        expectedGeneration: body.writerGeneration,
      });
      await store.abort({ writer });
      aborted++;
    } catch (error) {
      errors.push(Object.freeze({
        bodyId: body.bodyId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return Object.freeze({
    examined,
    aborted,
    deferred,
    errors: Object.freeze(errors),
  });
}
