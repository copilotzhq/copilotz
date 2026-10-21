import { isCollectionConflictError } from "@copilotz/copilotz/collections/authoring";

function retryableCoreMutationFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (
    (typeof current === "object" && current !== null) ||
    typeof current === "function"
  ) {
    const candidate = current as Record<string, unknown>;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    if (
      candidate.indeterminate === true || candidate.outcome === "unknown" ||
      candidate.execution === "indeterminate" ||
      ["owner_commit_unknown", "persistence_indeterminate"].includes(
        String(candidate.code),
      )
    ) return false;
    if (isCollectionConflictError(current)) return true;
    if (candidate.retryable === false) return false;
    const code = candidate.code ?? candidate.sqlState ?? candidate.sqlstate;
    if (code === "40P01" || code === "40001") return true;
    if (
      typeof candidate.message === "string" &&
      (candidate.message.includes("changed while its mutation was prepared") ||
        /(?:^|:\s*)deadlock detected(?:$|\n)/i.test(candidate.message) ||
        /(?:^|:\s*)could not serialize access(?:\b|$)/i.test(
          candidate.message,
        ))
    ) return true;
    current = candidate.cause;
  }
  return false;
}

/** Retries only known transient collection transaction failures. */
export async function retryCoreMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 8 || !retryableCoreMutationFailure(error)
      ) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25, 2 ** attempt))
      );
    }
  }
}
