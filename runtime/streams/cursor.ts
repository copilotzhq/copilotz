import { snapshotStreamMetadata } from "./json.ts";

export const OPERATION_REPLAY_CURSOR_FINGERPRINT = "operation-lanes";
export const MAX_OPERATION_CURSOR_STREAMS = 256;
// Base64url expands this to at most ~22 KiB, leaving aggregate header room for
// authentication cookies on managed HTTP frontends such as Cloud Run.
export const MAX_OPERATION_REPLAY_CURSOR_BYTES = 16 * 1024;

export type OperationStreamReplayPosition = Readonly<{
  /** Every operation-local ordinal at or below this value is consumed. */
  highWatermark: number;
  /** Explicit partial/open exceptions; these win over the high-watermark. */
  offsets: Readonly<Record<string, number>>;
}>;

export type OperationReplayPosition = Readonly<{
  eventPosition?: string;
  operationEventPositions?: Readonly<Record<string, string>>;
  operationStreamPositions?: Readonly<
    Record<string, OperationStreamReplayPosition>
  >;
}>;

export type OperationReplayCursorMutation =
  | Readonly<{
    kind: "event";
    position: string;
    operationId?: string;
  }>
  | Readonly<{
    kind: "operation-stream";
    action: "register" | "offset" | "end";
    operationId: string;
    streamOrdinal: string;
    offset: number;
  }>;

export type OperationReplayCursorTracker = Readonly<{
  cursor(mutations?: readonly OperationReplayCursorMutation[]): string;
  commit(mutations: readonly OperationReplayCursorMutation[]): void;
  streamPosition(
    input: Readonly<{
      operationId: string;
      streamOrdinal: string;
    }>,
  ): Readonly<{ consumed: boolean; offset: number }>;
}>;

function invalidCursor(message = "Operation replay cursor is invalid."): Error {
  return Object.assign(new TypeError(message), {
    status: 400,
    code: "invalid_replay_cursor",
  });
}

function replayCapacity(message: string): Error {
  return Object.assign(new TypeError(message), {
    status: 409,
    code: "operation_replay_capacity_exceeded",
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw invalidCursor();
  }
  if (binary.length > MAX_OPERATION_REPLAY_CURSOR_BYTES) {
    throw replayCapacity("Operation replay cursor is too large.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function eventPosition(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalidCursor();
  }
  return value;
}

function offsets(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCursor();
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OPERATION_CURSOR_STREAMS) {
    throw replayCapacity(
      "Operation replay cursor contains too many concurrent streams.",
    );
  }
  const result: Record<string, number> = {};
  for (const [streamId, offset] of entries) {
    if (
      !streamId.trim() || streamId.length > 512 ||
      !Number.isSafeInteger(offset) || Number(offset) < 0
    ) {
      throw invalidCursor();
    }
    result[streamId] = Number(offset);
  }
  return Object.freeze(result);
}

function operationPositions(
  value: unknown,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCursor();
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OPERATION_CURSOR_STREAMS) {
    throw replayCapacity(
      "Operation replay cursor contains too many operations.",
    );
  }
  const result: Record<string, string> = {};
  for (const [operationId, position] of entries) {
    if (!operationId.trim() || operationId.length > 512) throw invalidCursor();
    result[operationId] = eventPosition(position)!;
  }
  return Object.freeze(result);
}

function ordinal(value: unknown): number {
  const resolved = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) {
    throw invalidCursor();
  }
  return Number(resolved);
}

function operationStreams(
  value: unknown,
): Readonly<Record<string, OperationStreamReplayPosition>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCursor();
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OPERATION_CURSOR_STREAMS) {
    throw replayCapacity(
      "Operation replay cursor contains too many operations.",
    );
  }
  const result: Record<string, OperationStreamReplayPosition> = {};
  for (const [operationId, state] of entries) {
    if (
      !operationId.trim() || operationId.length > 512 ||
      !Array.isArray(state) || state.length !== 2
    ) throw invalidCursor();
    const streamOffsets = offsets(state[1]);
    for (const key of Object.keys(streamOffsets)) {
      if (!/^[1-9][0-9]*$/.test(key)) throw invalidCursor();
    }
    result[operationId] = Object.freeze({
      highWatermark: ordinal(state[0]),
      offsets: streamOffsets,
    });
  }
  return Object.freeze(result);
}

function operationStreamsJson(
  value: Readonly<Record<string, OperationStreamReplayPosition>> | undefined,
): Readonly<
  Record<string, readonly [number, Readonly<Record<string, number>>]>
> {
  const result: Record<
    string,
    readonly [number, Readonly<Record<string, number>>]
  > = {};
  for (const [operationId, state] of Object.entries(value ?? {})) {
    if (!operationId.trim() || operationId.length > 512) throw invalidCursor();
    const highWatermark = ordinal(state.highWatermark);
    const streamOffsets = offsets(state.offsets);
    for (const key of Object.keys(streamOffsets)) {
      if (!/^[1-9][0-9]*$/.test(key)) throw invalidCursor();
    }
    if (highWatermark > 0 || Object.keys(streamOffsets).length > 0) {
      result[operationId] = Object.freeze([highWatermark, streamOffsets]);
    }
  }
  if (Object.keys(result).length > MAX_OPERATION_CURSOR_STREAMS) {
    throw replayCapacity(
      "Operation replay cursor contains too many operations.",
    );
  }
  return Object.freeze(result);
}

function assertSparseCapacity(
  operation: Readonly<Record<string, OperationStreamReplayPosition>>,
): void {
  const sparse = Object.values(operation).reduce(
    (total, state) => total + Object.keys(state.offsets).length,
    0,
  );
  if (sparse > MAX_OPERATION_CURSOR_STREAMS) {
    throw replayCapacity(
      "Operation replay cursor contains too many concurrent streams.",
    );
  }
}

export function encodeOperationReplayCursor(
  position: OperationReplayPosition,
): string {
  const operation = operationStreams(
    operationStreamsJson(position.operationStreamPositions),
  );
  assertSparseCapacity(operation);
  const normalized = Object.freeze({
    kind: OPERATION_REPLAY_CURSOR_FINGERPRINT,
    ...(eventPosition(position.eventPosition)
      ? { event: eventPosition(position.eventPosition) }
      : {}),
    ...(position.operationEventPositions &&
        Object.keys(position.operationEventPositions).length
      ? { operations: operationPositions(position.operationEventPositions) }
      : {}),
    ...(Object.keys(operation).length
      ? { lanes: operationStreamsJson(operation) }
      : {}),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  if (bytes.byteLength > MAX_OPERATION_REPLAY_CURSOR_BYTES) {
    throw replayCapacity("Operation replay cursor is too large.");
  }
  return base64Url(bytes);
}

export function decodeOperationReplayCursor(
  cursor: string | null | undefined,
): OperationReplayPosition {
  if (cursor === undefined || cursor === null || !cursor.trim()) {
    return Object.freeze({});
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(cursor.trim()),
    ));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "invalid_replay_cursor") {
      throw error;
    }
    throw invalidCursor();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw invalidCursor();
  }
  const value = snapshotStreamMetadata(decoded) as Record<string, unknown>;
  if (
    value.kind !== OPERATION_REPLAY_CURSOR_FINGERPRINT ||
    Object.keys(value).some((key) =>
      !["kind", "event", "operations", "lanes"].includes(key)
    )
  ) {
    throw invalidCursor();
  }
  const event = eventPosition(value.event);
  const operations = operationPositions(value.operations);
  const lanes = operationStreams(value.lanes);
  assertSparseCapacity(lanes);
  return Object.freeze({
    ...(event ? { eventPosition: event } : {}),
    ...(Object.keys(operations).length
      ? { operationEventPositions: operations }
      : {}),
    ...(Object.keys(lanes).length ? { operationStreamPositions: lanes } : {}),
  });
}

function streamOrdinal(replayKey: string): number {
  if (!/^[1-9][0-9]*$/.test(replayKey.trim())) throw invalidCursor();
  const value = Number(replayKey);
  if (!Number.isSafeInteger(value)) throw invalidCursor();
  return value;
}

function mutablePosition(position: OperationReplayPosition) {
  return {
    eventPosition: position.eventPosition,
    operationEventPositions: { ...position.operationEventPositions },
    operationStreamPositions: Object.fromEntries(
      Object.entries(position.operationStreamPositions ?? {}).map(
        ([operationId, state]) => [operationId, {
          highWatermark: state.highWatermark,
          offsets: { ...state.offsets },
        }],
      ),
    ) as Record<
      string,
      { highWatermark: number; offsets: Record<string, number> }
    >,
  };
}

function snapshotMutable(
  position: ReturnType<typeof mutablePosition>,
): OperationReplayPosition {
  return Object.freeze({
    ...(position.eventPosition
      ? { eventPosition: position.eventPosition }
      : {}),
    ...(Object.keys(position.operationEventPositions).length
      ? { operationEventPositions: position.operationEventPositions }
      : {}),
    ...(Object.keys(position.operationStreamPositions).length
      ? { operationStreamPositions: position.operationStreamPositions }
      : {}),
  });
}

function applyMutation(
  position: ReturnType<typeof mutablePosition>,
  mutation: OperationReplayCursorMutation,
): void {
  if (mutation.kind === "event") {
    if (mutation.operationId) {
      position.operationEventPositions[mutation.operationId] =
        mutation.position;
    } else position.eventPosition = mutation.position;
    return;
  }
  const operationId = mutation.operationId.trim();
  if (!operationId) throw invalidCursor();
  const ordinal = streamOrdinal(mutation.streamOrdinal);
  const key = String(ordinal);
  const state = position.operationStreamPositions[operationId] ??= {
    highWatermark: 0,
    offsets: {},
  };
  if (mutation.action === "register") {
    if (ordinal > state.highWatermark) {
      if (ordinal - state.highWatermark > MAX_OPERATION_CURSOR_STREAMS + 1) {
        throw replayCapacity(
          "Operation replay cursor contains too many concurrent streams.",
        );
      }
      for (let value = state.highWatermark + 1; value <= ordinal; value++) {
        state.offsets[String(value)] ??= 0;
      }
    }
    if (ordinal > state.highWatermark || key in state.offsets) {
      state.offsets[key] = Math.max(state.offsets[key] ?? 0, mutation.offset);
    }
    return;
  }
  state.offsets[key] = mutation.offset;
  if (mutation.action !== "end") return;
  if (ordinal > state.highWatermark) {
    if (ordinal - state.highWatermark > MAX_OPERATION_CURSOR_STREAMS + 1) {
      throw replayCapacity(
        "Operation replay cursor contains too many concurrent streams.",
      );
    }
    for (let value = state.highWatermark + 1; value < ordinal; value++) {
      state.offsets[String(value)] ??= 0;
    }
    state.highWatermark = ordinal;
  }
  delete state.offsets[key];
}

export function createOperationReplayCursorTracker(
  initial: OperationReplayPosition,
): OperationReplayCursorTracker {
  let position = mutablePosition(initial);
  const candidate = (mutations: readonly OperationReplayCursorMutation[]) => {
    const next = mutablePosition(snapshotMutable(position));
    for (const mutation of mutations) {
      applyMutation(next, mutation);
    }
    return next;
  };
  return Object.freeze({
    cursor(mutations = []) {
      return encodeOperationReplayCursor(
        snapshotMutable(candidate(mutations)),
      );
    },
    commit(mutations) {
      position = candidate(mutations);
    },
    streamPosition(input) {
      const ordinal = streamOrdinal(input.streamOrdinal);
      const state = position.operationStreamPositions[input.operationId];
      const sparse = state?.offsets[String(ordinal)];
      if (sparse !== undefined) {
        return Object.freeze({ consumed: false, offset: sparse });
      }
      if (state && ordinal <= state.highWatermark) {
        return Object.freeze({ consumed: true, offset: 0 });
      }
      return Object.freeze({ consumed: false, offset: 0 });
    },
  });
}
