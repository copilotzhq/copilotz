import type { ContentError, ContentErrorCode } from "./types.ts";

/** Creates typed content errors without custom error constructors. */
export function createContentError(
  code: ContentErrorCode,
  message: string,
  context: { assetId?: string; namespace?: string; cause?: unknown } = {},
): ContentError {
  const error = new Error(message, { cause: context.cause }) as ContentError;
  error.name = "CopilotzContentError";
  error.code = code;
  if (context.assetId) error.assetId = context.assetId;
  if (context.namespace) error.namespace = context.namespace;
  return error;
}

export function isContentError(error: unknown): error is ContentError {
  return error instanceof Error &&
    typeof (error as Partial<ContentError>).code === "string";
}
