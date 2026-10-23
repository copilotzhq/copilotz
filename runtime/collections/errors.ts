import { markNonRetryable } from "../failure.ts";

/** A deterministic rejection of a Collection's schema or declared relations. */
export type CollectionValidationError =
  & TypeError
  & Readonly<{
    code: "collection_validation_failed";
  }>;

export function createCollectionValidationError(
  message: string,
): CollectionValidationError {
  return markNonRetryable(Object.assign(new TypeError(message), {
    name: "CollectionValidationError",
    code: "collection_validation_failed" as const,
  }));
}

export function isCollectionValidationError(
  error: unknown,
): error is CollectionValidationError {
  return error instanceof TypeError &&
    error.name === "CollectionValidationError" &&
    (error as Partial<CollectionValidationError>).code ===
      "collection_validation_failed";
}

/** A namespace-local identity collision; contains no storage or record details. */
export type CollectionConflictError =
  & Error
  & Readonly<{ code: "collection_conflict"; status: 409 }>;
export function createCollectionConflictError(): CollectionConflictError {
  return markNonRetryable(Object.assign(new Error("Record already exists."), {
    name: "CollectionConflictError",
    code: "collection_conflict" as const,
    status: 409 as const,
  }));
}
export function isCollectionConflictError(
  error: unknown,
): error is CollectionConflictError {
  return error instanceof Error &&
    (error as Partial<CollectionConflictError>).code === "collection_conflict";
}

/** Never expose a physical node key error, including an external writer race. */
export function rethrowNodeIdentityConflict(error: unknown): never {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      value.code === "23505" &&
      (value.constraint === "nodes_pkey" ||
        value.message?.includes('"nodes_pkey"'))
    ) {
      throw createCollectionConflictError();
    }
    current = value.cause;
  }
  throw error;
}
