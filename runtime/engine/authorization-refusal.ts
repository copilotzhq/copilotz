import { ActionError } from "../actions/errors.ts";
/** Private owner classification. Wire error codes/messages never grant cleanup. */
import { markNonRetryable } from "../failure.ts";
const refusals = new WeakSet<object>();
export function isOwnerAuthorizationRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && refusals.has(error);
}
export function markOwnerAuthorizationRefusal<T extends Error>(error: T): T {
  refusals.add(error);
  return error;
}
export function withOwnerPolicyRefusal<R>(
  run: () => R,
  signal?: AbortSignal,
): R {
  const refuse = (caught: unknown): never => {
    if (signal?.aborted) throw caught;
    if (
      caught instanceof ActionError && caught.code === "forbidden" &&
      caught.status === 403
    ) refusals.add(caught);
    throw caught;
  };
  try {
    const result = run();
    return result instanceof Promise ? result.catch(refuse) as R : result;
  } catch (caught) {
    return refuse(caught);
  }
}
export function sanitizedAuthorizationRefusal(indeterminate = false): Error {
  const error = markNonRetryable(
    Object.assign(
      new Error(
        indeterminate
          ? "An external effect has no confirmed outcome."
          : "Action authorization was refused.",
      ),
      {
        code: indeterminate
          ? "effect_indeterminate"
          : "action_authorization_refused",
        name: indeterminate
          ? "ActionEffectError"
          : "ActionAuthorizationRefused",
      },
    ),
  );
  refusals.add(error);
  return error;
}
