import type { CopilotzClient } from "../index.ts";
import type {
  ActionTransport,
  BrowserRuntimeOptions,
  ReadFailure,
} from "./types.ts";

export class ActionFailure extends Error {
  override name = "ActionFailure";
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Exact owner sequence; never invent progress for a missing/unsafe result. */
export function ownerSequence(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new ActionFailure(
    "invalid_sequence",
    "Operation result has no valid owner sequence.",
  );
}

export function rejectActionFailure(value: unknown): void {
  if (
    !value || typeof value !== "object" || !("ok" in value) ||
    value.ok !== false
  ) return;
  const detail = "error" in value ? value.error : undefined;
  const error = detail && typeof detail === "object"
    ? detail as Record<string, unknown>
    : {};
  throw new ActionFailure(
    typeof error.code === "string" ? error.code : "action_failed",
    typeof detail === "string"
      ? detail
      : typeof error.message === "string"
      ? error.message
      : "The operation was rejected.",
    typeof error.status === "number" ? error.status : undefined,
  );
}

export function readFailure(cause: unknown): ReadFailure {
  const error = cause && typeof cause === "object"
    ? cause as Record<string, unknown>
    : {};
  const status = typeof error.status === "number" ? error.status : undefined;
  const code = typeof error.code === "string" ? error.code : "unavailable";
  const denied = status === 401 || status === 403 ||
    ["forbidden", "unauthorized", "revoked", "denied"].includes(code);
  const unavailable = status !== undefined &&
    (status >= 500 || [408, 425, 429].includes(status));
  const invalid = status !== undefined
    ? status >= 400 && status < 500
    : cause instanceof ActionFailure || error.name === "ProtocolError" ||
      code.startsWith("invalid_") || code === "validation_error";
  const kind = denied
    ? "denied"
    : unavailable
    ? "unavailable"
    : invalid
    ? "invalid"
    : "unavailable";
  return Object.freeze({
    kind,
    code,
    message: typeof error.message === "string" ? error.message : String(cause),
    ...(status === undefined ? {} : { status }),
    retryable: kind === "unavailable",
  });
}

/** One SDK client supplies live Collections and terminal Action proxies. */
export function createBrowserPorts(
  client: CopilotzClient,
): Required<Pick<BrowserRuntimeOptions, "live" | "actions">> {
  const actions: ActionTransport = {
    async invoke(id, input, options) {
      const receipt = await client.actions.submit(id, input, options);
      options.accepted(receipt.operationId);
      // The existing operation observer follows the operation to terminal without polling.
      await client.operations.observe({
        operationIds: [receipt.operationId],
        signal: options.signal,
        onFrame() {},
      });
      const outcome = await client.operations.result(
        receipt.operationId,
        options.signal,
      );
      rejectActionFailure(outcome.value);
      return { value: outcome.value, seq: ownerSequence(outcome.seq) };
    },
    async cancel(id) {
      await client.operations.cancel(id);
    },
  };
  return { live: client.subscriptions, actions };
}
