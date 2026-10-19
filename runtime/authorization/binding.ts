/** Host admission binds retained data to the existing revocable owner invocation. */
import { type AuthenticatedAuthority, retainedAuthority } from "./authority.ts";
import { withOwnerCollectionInvocation } from "./invocation.ts";

export function withRetainedAuthority<T>(
  value: AuthenticatedAuthority,
  signal: AbortSignal,
  run: () => T | Promise<T>,
): Promise<T> {
  const authority = retainedAuthority(value);
  return withOwnerCollectionInvocation({
    authority,
    scope: authority.scope,
    invocation: {
      kind: "processor",
      id: authority.principal.id,
      runId: authority.validity.kind === "attempt"
        ? authority.validity.attempt
        : crypto.randomUUID(),
    },
    signal,
    check: () => signal.throwIfAborted(),
    resolveSource: () =>
      Promise.reject(new Error("Ingress authority has no execution source.")),
  }, run);
}
