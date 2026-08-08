import type { EventStoreError, EventStoreErrorCode } from "./types.ts";

export function createEventStoreError(
  code: EventStoreErrorCode,
  message: string,
  cause?: unknown,
): EventStoreError {
  const error = new Error(message, { cause }) as EventStoreError;
  error.name = "CopilotzEventStoreError";
  error.code = code;
  return error;
}

export function isEventStoreError(error: unknown): error is EventStoreError {
  return error instanceof Error &&
    typeof (error as Partial<EventStoreError>).code === "string";
}
