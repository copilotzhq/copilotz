/**
 * A batch of actions, one after another, each within its own timeout. A
 * timeout spoils the batch even when it goes on after errors: what was
 * uncertain is never replayed, and the browser is retired (its Chrome stops,
 * to start again on its next batch).
 */
import { deadline, isBrowserError, message, race } from "./async.ts";
import type { Action, Request, Result } from "./types.ts";

export async function runBatch(
  request: Request,
  signal: AbortSignal,
  actionTimeout: number,
  execute: (action: Action, signal: AbortSignal) => Promise<Record<string, unknown>>,
  retire: () => Promise<void>,
): Promise<Omit<Result, "window">> {
  const result: Omit<Result, "window"> = { success: true, stoppedEarly: false, results: [] };
  for (const [actionIndex, action] of request.actions.entries()) {
    // A bare wait takes its whole time: give it a moment more to finish.
    const ms = (action.timeoutMs ?? actionTimeout) +
      (action.action === "wait" && !action.until ? 100 : 0);
    const limit = deadline(Math.min(ms, 300_000), signal);
    try {
      limit.signal.throwIfAborted();
      const value = await race(execute(action, limit.signal), limit.signal);
      result.results.push({ action: action.action, actionIndex, success: true, ...value });
      if (value.success === false) result.success = false;
      if (action.action === "close") break;
    } catch (error) {
      result.success = false;
      result.results.push({
        action: action.action,
        actionIndex,
        success: false,
        error: message(error),
        code: isBrowserError(error) ? error.code : signal.aborted ? "aborted" : "action_failed",
      });
      const spoiled = limit.signal.aborted || (isBrowserError(error) && error.code === "timeout");
      if (spoiled) await retire().catch(() => {});
      if (spoiled || (request.stopOnError ?? true)) {
        result.stoppedEarly = actionIndex < request.actions.length - 1;
        break;
      }
    } finally {
      limit.dispose();
    }
  }
  return result;
}
