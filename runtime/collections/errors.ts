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
