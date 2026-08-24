/** An Error explicitly classified as deterministic and unsafe to retry. */
export type NonRetryableError = Error & Readonly<{ retryable: false }>;

/**
 * Marks an existing Error as non-retryable without changing its prototype,
 * name, message, stack, or cause. This lets domain-specific errors such as
 * TypeError retain their ordinary identity while giving durable execution an
 * explicit failure disposition.
 */
export function markNonRetryable<TError extends Error>(
  error: TError,
): TError & NonRetryableError {
  if (!(error instanceof Error)) {
    throw new TypeError("markNonRetryable requires an Error instance.");
  }
  const current = Object.getOwnPropertyDescriptor(error, "retryable");
  if (current && "value" in current && current.value === false) {
    return error as TError & NonRetryableError;
  }
  Object.defineProperty(error, "retryable", {
    value: false,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return error as TError & NonRetryableError;
}

/** Returns the nearest explicit retryability marker in an Error cause chain. */
export function errorRetryability(error: unknown): boolean | undefined {
  const visited = new Set<object>();
  let current = error;
  while (
    (typeof current === "object" && current !== null) ||
    typeof current === "function"
  ) {
    const candidate = current as object;
    if (visited.has(candidate)) return undefined;
    visited.add(candidate);
    try {
      const marker = Object.getOwnPropertyDescriptor(candidate, "retryable");
      if (
        marker && "value" in marker && typeof marker.value === "boolean"
      ) {
        return marker.value;
      }
      const cause = Object.getOwnPropertyDescriptor(candidate, "cause");
      if (!cause || !("value" in cause)) return undefined;
      current = cause.value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isNonRetryableError(
  error: unknown,
): error is NonRetryableError {
  return errorRetryability(error) === false;
}
