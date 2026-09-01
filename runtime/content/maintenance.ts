import type {
  ActiveMutableBodyHead,
  BodyStore,
  MutableBodyHead,
  TerminalBodyHead,
} from "./body-store.ts";

export type ProgressiveBodyMaintenanceError = Readonly<{
  bodyId: string;
  message: string;
}>;

/** Result of domain-neutral recovery for expired progressive Body writers. */
export type ProgressiveBodyMaintenanceResult = Readonly<{
  examined: number;
  aborted: number;
  /** Expired frozen sealing bodies finalized without reopening appends. */
  sealed: number;
  /** Expired open/terminating bodies frozen as immutable incomplete prefixes. */
  terminated: number;
  deferred: number;
  errors: readonly ProgressiveBodyMaintenanceError[];
  /** Opaque BodyStore continuation for the next bounded maintenance pass. */
  after?: string;
}>;

export const EMPTY_PROGRESSIVE_BODY_MAINTENANCE:
  ProgressiveBodyMaintenanceResult = Object.freeze({
    examined: 0,
    aborted: 0,
    sealed: 0,
    terminated: 0,
    deferred: 0,
    errors: Object.freeze([]),
  });

function isActive(
  head: TerminalBodyHead | MutableBodyHead,
): head is ActiveMutableBodyHead {
  return head.state === "open" || head.state === "sealing" ||
    head.state === "terminating";
}

/**
 * Recovers progressive Bodies whose writer lease has expired.
 *
 * This is deliberately ignorant of the semantic owner of a Body. A live body
 * renews its lease independently of byte traffic. Expired open/terminating
 * bodies are fenced and frozen as incomplete so generic recovery never erases
 * a prefix that may already have been published. Sealing is irrevocable, so an
 * expired frozen body is fenced and finalized. Terminal-body collection stays
 * with retention/orphan maintenance.
 */
export async function maintainProgressiveBodies(
  store: BodyStore,
  input: Readonly<{ limit?: number; after?: string }> = {},
): Promise<ProgressiveBodyMaintenanceResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError("Progressive body maintenance limit must be 1..10000.");
  }
  const page = await store.maintenance.list({
    states: ["open", "sealing", "terminating", "aborted"],
    idleForMs: 0,
    ...(input.after ? { after: input.after } : {}),
    limit,
  });
  let examined = 0;
  let aborted = 0;
  let sealed = 0;
  let terminated = 0;
  let deferred = 0;
  const errors: ProgressiveBodyMaintenanceError[] = [];
  for (const body of page.bodies) {
    examined++;
    if (body.state === "aborted") {
      try {
        const deleted = await store.maintenance.delete({
          bodyId: body.bodyId,
          expectedState: "aborted",
          expectedMaintenanceVersion: body.maintenanceVersion,
          idleForMs: 0,
        });
        if (deleted) aborted++;
        else deferred++;
      } catch (error) {
        errors.push(Object.freeze({
          bodyId: body.bodyId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      continue;
    }
    if (!isActive(body)) continue;
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
      if (body.state === "sealing") {
        await store.seal({
          writer,
          expectedByteLength: body.byteLength,
        });
        sealed++;
      } else if (
        (await store.head({ bodyId: body.bodyId }))?.state === "ready"
      ) {
        // Seal publishes Ready before opportunistic staging cleanup. A crash
        // in that cleanup leaves an open-looking residue whose bytes are
        // already represented by the immutable canonical Body.
        await store.abort({ writer });
        aborted++;
      } else {
        await store.terminate({
          writer,
          expectedByteLength: body.byteLength,
        });
        terminated++;
      }
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
    sealed,
    terminated,
    deferred,
    errors: Object.freeze(errors),
    ...(page.after ? { after: page.after } : {}),
  });
}
