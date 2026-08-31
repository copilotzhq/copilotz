import type {
  EventNativeApp,
  EventNativeAppError,
  EventNativeAppRequest,
  EventNativeAppResponse,
  EventNativeOutputStream,
} from "./event-native.ts";
import { isEventNativeOutputStream } from "./event-native.ts";
import type {
  ApplicationOutput,
  StreamOutput,
} from "../runtime/streams/index.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  type OperationReplayCursorMutation,
  operationStreamReplayCursorKey,
} from "../runtime/streams/index.ts";

export type EventNativeSseProjector = (
  output: ApplicationOutput,
  request: Request,
) =>
  | unknown
  | readonly unknown[]
  | null
  | Promise<unknown | readonly unknown[] | null>;

export type EventNativeRawBodyPolicy = Readonly<{
  /** Hard byte cap enforced while consuming the request stream. */
  maxBytes: number;
  /** Optional bounded 413 error projection for the selected raw route. */
  tooLarge?: Readonly<{ code: string; message: string }>;
}>;

export type CreateEventNativeFetchHandlerOptions = Readonly<{
  /** Optional route prefix, for example /v2. */
  basePath?: string;
  resolveContext?: (
    request: Request,
  ) =>
    | EventNativeAppRequest["context"]
    | Response
    | Promise<EventNativeAppRequest["context"] | Response>;
  /** Selects routes whose body is opaque bytes even when Content-Type is JSON. */
  rawBody?: (
    request: Request,
    context: EventNativeAppRequest["context"] | undefined,
  ) => boolean | EventNativeRawBodyPolicy;
  responseHeaders?: Readonly<Record<string, string>>;
  /** Optional versioned projection applied only to request-bound SSE output. */
  projectSseOutput?: EventNativeSseProjector;
  /** Optional SSE event name derived from a projected output value. */
  sseEventName?: (value: unknown) => string | undefined;
  /** New facades negotiate JSON, SSE, or lossless multipart. Legacy defaults to SSE. */
  streamResponseMode?: "sse" | "negotiate";
  onError?: (error: unknown, request: Request) => void | Promise<void>;
}>;

export type EventNativeFetchHandler = (request: Request) => Promise<Response>;

const METHODS = new Set<EventNativeAppRequest["method"]>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "QUERY",
]);

function basePath(value: string | undefined): string {
  if (!value || value === "/") return "";
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ? "" : normalized;
}

function route(url: URL, base: string): readonly string[] | null {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) {
    return null;
  }
  const relative = base ? pathname.slice(base.length) : pathname;
  return Object.freeze(
    relative.split("/").filter(Boolean).map((part) => decodeURIComponent(part)),
  );
}

function query(url: URL): EventNativeAppRequest["query"] {
  const values: Record<string, string | readonly string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    values[key] = all.length === 1 ? all[0] : Object.freeze(all);
  }
  return Object.freeze(values);
}

function headers(request: Request): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(request.headers.entries()));
}

function rawBodyTooLarge(policy: EventNativeRawBodyPolicy): Error {
  return Object.assign(
    new Error(
      policy.tooLarge?.message ??
        `Request body exceeds the ${policy.maxBytes}-byte limit.`,
    ),
    {
      status: 413,
      code: policy.tooLarge?.code ?? "request_body_too_large",
    },
  );
}

async function readBodyBytes(
  request: Request,
  policy: EventNativeRawBodyPolicy | undefined,
): Promise<Uint8Array> {
  if (!policy) return new Uint8Array(await request.arrayBuffer());
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new TypeError(
      "Raw request body maxBytes must be a positive integer.",
    );
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > policy.maxBytes) {
        void reader.cancel(rawBodyTooLarge(policy)).catch(() => undefined);
        throw rawBodyTooLarge(policy);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

async function body(
  request: Request,
  rawPolicy: boolean | EventNativeRawBodyPolicy = false,
): Promise<
  Readonly<{
    value: unknown;
    raw?: Uint8Array;
  }>
> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { value: undefined };
  }
  const rawOnly = Boolean(rawPolicy);
  const raw = await readBodyBytes(
    request,
    typeof rawPolicy === "object" ? rawPolicy : undefined,
  );
  if (!raw.length) return { value: undefined, raw };
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (
    !rawOnly &&
    (mediaType === "application/json" || mediaType?.endsWith("+json"))
  ) {
    try {
      return { value: JSON.parse(new TextDecoder().decode(raw)), raw };
    } catch {
      throw Object.assign(new Error("Request body must contain valid JSON."), {
        status: 400,
        code: "invalid_json",
      });
    }
  }
  if (
    !rawOnly &&
    (mediaType?.startsWith("text/") || mediaType === "application/xml")
  ) {
    return { value: new TextDecoder().decode(raw), raw };
  }
  return { value: raw, raw };
}

function responseHeaders(
  options: CreateEventNativeFetchHandlerOptions,
  applicationHeaders?: HeadersInit,
): Headers {
  const result = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...(options.responseHeaders ?? {}),
  });
  if (!applicationHeaders) return result;
  const supplied = new Headers(applicationHeaders);
  supplied.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") result.set(name, value);
  });
  const cookieValues = (
    supplied as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ??
    (supplied.has("set-cookie") ? [supplied.get("set-cookie")!] : []);
  for (const value of cookieValues) result.append("set-cookie", value);
  return result;
}

async function jsonResponse(
  result: EventNativeAppResponse,
  options: CreateEventNativeFetchHandlerOptions,
  request: Request,
): Promise<Response> {
  if (result.status === 204) {
    return new Response(null, {
      status: result.status,
      headers: responseHeaders(options, result.headers),
    });
  }
  if (result.data instanceof Response) return result.data;
  if (isEventNativeOutputStream(result.data)) {
    if (options.streamResponseMode === "negotiate") {
      const accept = request.headers.get("accept")?.toLowerCase() ?? "";
      if (accept.includes("multipart/mixed")) {
        return applicationOutputsMultipartResponse(result.data, {
          headers: responseHeaders(options, result.headers),
        });
      }
      if (!accept.includes("text/event-stream")) {
        for await (const _output of result.data.outputs) {
          // JSON mode intentionally drains progressive output before settlement.
        }
        await result.data.done;
        return new Response(JSON.stringify({ data: { completed: true } }), {
          status: 200,
          headers: responseHeaders(options, result.headers),
        });
      }
    }
    return sseResponse(result.data, request, options, result.headers);
  }
  return new Response(
    JSON.stringify({
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.included !== undefined ? { included: result.included } : {}),
      ...(result.pageInfo ? { pageInfo: result.pageInfo } : {}),
    }),
    {
      status: result.status,
      headers: responseHeaders(options, result.headers),
    },
  );
}

function isStreamOutput(
  output: ApplicationOutput,
): output is StreamOutput {
  const payload = (output as { payload?: unknown }).payload;
  return output.type === "stream.output" && Boolean(payload) &&
    typeof (payload as { getReader?: unknown }).getReader === "function";
}

/**
 * Produces the canonical JSON-safe representation used by event-native SSE.
 * Byte streams keep their identity and metadata while their ReadableStream
 * remains on the transport-specific stream path.
 */
export function projectEventNativeSseOutput(
  output: ApplicationOutput,
): unknown {
  if (!isStreamOutput(output)) return output;
  const {
    payload: _payload,
    replayKey: _replayKey,
    streamOrdinal: _streamOrdinal,
    ...descriptor
  } = output;
  return Object.freeze(descriptor);
}

function durablePosition(output: ApplicationOutput): string | undefined {
  if (
    !("durable" in output) || output.durable !== true ||
    !("position" in output) || typeof output.position !== "string"
  ) {
    return undefined;
  }
  const position = output.position.replace(/[\r\n]/g, "").trim();
  return position || undefined;
}

function isTerminalOperationOutput(output: ApplicationOutput): boolean {
  return output.type === "operation.completed" ||
    output.type === "operation.failed" ||
    output.type === "operation.cancelled";
}

function sseFrame(
  value: unknown,
  event?: string,
  id?: string,
): Uint8Array {
  const name = event?.replace(/[\r\n]/g, "").trim();
  const resumeId = id?.replace(/[\r\n]/g, "").trim();
  return new TextEncoder().encode(
    `${name ? `event: ${name}\n` : ""}${
      resumeId ? `id: ${resumeId}\n` : ""
    }data: ${JSON.stringify(value)}\n\n`,
  );
}

function cancellationReason(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : String(reason ?? "cancelled");
}

function isReplayCapacityError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code ===
    "operation_replay_capacity_exceeded";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function operationContext(
  output: ApplicationOutput,
  fallback: Readonly<{ operationId?: string; threadId?: string }> = {},
): Readonly<{ operationId?: string; threadId?: string }> {
  const value = output as unknown as Record<string, unknown>;
  return Object.freeze({
    ...(typeof value.operationId === "string" && value.operationId.trim()
      ? { operationId: value.operationId.trim() }
      : fallback.operationId
      ? { operationId: fallback.operationId }
      : {}),
    ...(typeof value.threadId === "string" && value.threadId.trim()
      ? { threadId: value.threadId.trim() }
      : fallback.threadId
      ? { threadId: fallback.threadId }
      : {}),
  });
}

function projectOperationContext(
  value: unknown,
  output: ApplicationOutput,
  fallback: Readonly<{ operationId?: string; threadId?: string }> = {},
): unknown {
  const context = operationContext(output, fallback);
  if (
    !context.operationId || !value || typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  return Object.freeze({
    ...(value as Record<string, unknown>),
    operationId: context.operationId,
    ...(context.threadId ? { threadId: context.threadId } : {}),
  });
}

function sseResponse(
  stream: EventNativeOutputStream,
  request: Request,
  options: CreateEventNativeFetchHandlerOptions,
  applicationHeaders?: HeadersInit,
): Response {
  const initial = decodeOperationReplayCursor(stream.replayCursor);
  const cursorTracker = createOperationReplayCursorTracker(initial);
  const transport = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transport.writable.getWriter();
  const write = (value: Uint8Array) => writer.write(value);
  let frameTail: Promise<void> = Promise.resolve();
  const serializeFrame = <T>(task: () => Promise<T>): Promise<T> => {
    const result = frameTail.then(task, task);
    frameTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const writeFrame = (
    build: (replayCursor: string) => Uint8Array,
    mutations: Parameters<typeof cursorTracker.commit>[0] = [],
  ): Promise<void> =>
    serializeFrame(async () => {
      const frame = build(cursorTracker.cursor(mutations));
      await write(frame);
      cursorTracker.commit(mutations);
    });
  const pumps: Promise<void>[] = [];
  const pump = async (
    output: StreamOutput,
    context: Readonly<{ operationId?: string; threadId?: string }>,
    offset: number,
  ) => {
    const reader = output.payload.getReader();
    const replayKey = operationStreamReplayCursorKey(output);
    const streamMutation = (
      action: "offset" | "end",
      nextOffset: number,
    ) =>
      context.operationId && output.streamOrdinal
        ? {
          kind: "operation-stream" as const,
          action,
          operationId: context.operationId,
          streamOrdinal: output.streamOrdinal,
          offset: nextOffset,
        }
        : {
          kind: "legacy-stream" as const,
          replayKey,
          offset: nextOffset,
        };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const fromOffset = offset;
        const toOffset = offset + next.value.byteLength;
        const value = Object.freeze({
          type: "stream.chunk",
          ...context,
          streamId: output.streamId,
          fromOffset,
          toOffset,
          bytes: base64(next.value),
        });
        await writeFrame(
          (replayCursor) => sseFrame(value, "stream.chunk", replayCursor),
          [streamMutation("offset", toOffset)],
        );
        offset = toOffset;
      }
      const value = Object.freeze({
        type: "stream.end",
        ...context,
        streamId: output.streamId,
        offset,
      });
      await writeFrame(
        (replayCursor) => sseFrame(value, "stream.end", replayCursor),
        context.operationId && output.streamOrdinal
          ? [streamMutation("end", offset)]
          : [],
      );
    } finally {
      reader.releaseLock();
    }
  };
  const heartbeat = setInterval(() => {
    void serializeFrame(() =>
      write(new TextEncoder().encode(": heartbeat\n\n"))
    ).catch(() => undefined);
  }, 15_000);
  const outputReader = stream.outputs.getReader();
  void (async () => {
    try {
      while (true) {
        const next = await outputReader.read();
        if (next.done) break;
        const output = next.value;
        const context = operationContext(output, {
          ...(stream.operationId ? { operationId: stream.operationId } : {}),
          ...(stream.threadId ? { threadId: stream.threadId } : {}),
        });
        let streamOffset: number | undefined;
        const registration = isStreamOutput(output) && context.operationId &&
            output.streamOrdinal
          ? {
            kind: "operation-stream" as const,
            action: "register" as const,
            operationId: context.operationId,
            streamOrdinal: output.streamOrdinal,
            offset: cursorTracker.streamPosition({
              operationId: context.operationId,
              replayKey: output.replayKey,
              streamOrdinal: output.streamOrdinal,
              streamId: output.streamId,
            }).offset,
          }
          : undefined;
        if (isStreamOutput(output)) {
          const position = cursorTracker.streamPosition({
            operationId: context.operationId,
            replayKey: output.replayKey,
            streamOrdinal: output.streamOrdinal,
            streamId: output.streamId,
          });
          if (position.consumed) {
            await output.payload.cancel("operation_stream_already_consumed")
              .catch(() => undefined);
            continue;
          }
          streamOffset = position.offset;
        }
        // A terminal frame is an observation barrier: once a client applies
        // it, it is allowed to close the feed. Drain every stream already
        // published by this operation before exposing that boundary.
        if (isTerminalOperationOutput(output)) await Promise.all(pumps);
        const position = durablePosition(output);
        const projected = options.projectSseOutput
          ? await options.projectSseOutput(output, request)
          : projectEventNativeSseOutput(output);
        if (projected !== null && projected !== undefined) {
          const values = Array.isArray(projected) ? projected : [projected];
          for (let index = 0; index < values.length; index++) {
            const raw = values[index];
            // The cursor commits a durable output only on its final projected
            // frame. A disconnect between an earlier projection and this frame
            // therefore replays the Event instead of skipping its tail.
            const value = projectOperationContext(raw, output, context);
            const mutations: OperationReplayCursorMutation[] = [];
            if (position && index === values.length - 1) {
              mutations.push({
                kind: "event" as const,
                ...(stream.compositeCursor && context.operationId
                  ? { operationId: context.operationId }
                  : {}),
                position,
              });
              if (!stream.compositeCursor && context.operationId) {
                mutations.push({
                  kind: "event",
                  operationId: context.operationId,
                  position,
                });
              }
            }
            if (registration && index === values.length - 1) {
              mutations.push(registration);
            }
            await writeFrame(
              (replayCursor) =>
                sseFrame(
                  value,
                  options.sseEventName?.(value),
                  replayCursor,
                ),
              mutations,
            );
          }
        } else if (position || registration) {
          // A filtered output has no transport frame to acknowledge. Commit it
          // before the next visible frame; replaying it remains harmless because
          // the projector deterministically omits it again.
          await serializeFrame(() => {
            const mutations: OperationReplayCursorMutation[] = [];
            if (position) {
              mutations.push({
                kind: "event",
                ...(stream.compositeCursor && context.operationId
                  ? { operationId: context.operationId }
                  : {}),
                position,
              });
              if (!stream.compositeCursor && context.operationId) {
                mutations.push({
                  kind: "event",
                  operationId: context.operationId,
                  position,
                });
              }
            }
            if (registration) mutations.push(registration);
            cursorTracker.commit(mutations);
            return Promise.resolve();
          });
        }
        if (isStreamOutput(output)) {
          pumps.push(pump(output, context, streamOffset ?? 0));
        }
      }
      await Promise.all(pumps);
      await stream.done;
      clearInterval(heartbeat);
      await frameTail;
      await writer.close();
    } catch (error) {
      clearInterval(heartbeat);
      if (isReplayCapacityError(error)) {
        await writeFrame(
          (replayCursor) =>
            sseFrame(
              Object.freeze({
                type: "replay.capacity",
                code: "operation_replay_capacity_exceeded",
                ...(stream.operationId
                  ? { operationId: stream.operationId }
                  : {}),
                ...(stream.threadId ? { threadId: stream.threadId } : {}),
              }),
              "replay.capacity",
              replayCursor,
            ),
        ).catch(() => undefined);
        await stream.cancel("operation_replay_capacity_exceeded").catch(() =>
          undefined
        );
        await Promise.allSettled(pumps);
        await frameTail;
        await writer.close().catch(() => undefined);
        return;
      }
      await stream.cancel(cancellationReason(error)).catch(() => undefined);
      await writer.abort(error).catch(() => undefined);
    } finally {
      outputReader.releaseLock();
    }
  })();
  const transportReader = transport.readable.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await transportReader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      clearInterval(heartbeat);
      await transportReader.cancel(reason).catch(() => undefined);
      await outputReader.cancel(reason).catch(() => undefined);
      await stream.cancel(cancellationReason(reason)).catch(() => undefined);
      await writer.abort(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: (() => {
      const headers = responseHeaders(options, applicationHeaders);
      headers.set("cache-control", "no-cache");
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("x-accel-buffering", "no");
      return headers;
    })(),
  });
}

function errorResponse(
  error: unknown,
  options: CreateEventNativeFetchHandlerOptions,
): Response {
  const typed = error as Partial<EventNativeAppError> & {
    retryAfterSeconds?: unknown;
  };
  const status = typeof typed?.status === "number" &&
      typed.status >= 400 && typed.status <= 599
    ? typed.status
    : 500;
  const code = typeof typed?.code === "string" && typed.code
    ? typed.code
    : "internal_error";
  const availability = code === "persistence_unavailable" ||
    code === "persistence_indeterminate";
  const message = (status < 500 || availability) && error instanceof Error
    ? error.message
    : "Internal application error.";
  const response = responseHeaders(options);
  if (
    availability && typeof typed.retryAfterSeconds === "number" &&
    Number.isSafeInteger(typed.retryAfterSeconds) &&
    typed.retryAfterSeconds >= 0
  ) {
    response.set("retry-after", String(typed.retryAfterSeconds));
  }
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: response,
  });
}

/** Adapts the framework-neutral event-native app to the Web Fetch contract. */
export function createEventNativeFetchHandler(
  app: EventNativeApp,
  options: CreateEventNativeFetchHandlerOptions = {},
): EventNativeFetchHandler {
  const base = basePath(options.basePath);
  return async (request) => {
    try {
      const method = request.method.toUpperCase();
      if (!METHODS.has(method as EventNativeAppRequest["method"])) {
        throw Object.assign(new Error("HTTP method is not supported."), {
          status: 405,
          code: "method_not_allowed",
        });
      }
      const url = new URL(request.url);
      const parts = route(url, base);
      if (!parts?.length) {
        throw Object.assign(new Error("Application route was not found."), {
          status: 404,
          code: "route_not_found",
        });
      }
      const context = await options.resolveContext?.(request);
      if (context instanceof Response) return context;
      const parsedBody = await body(
        request,
        options.rawBody?.(request, context),
      );
      const result = await app.handle({
        resource: parts[0],
        method: method as EventNativeAppRequest["method"],
        path: Object.freeze(parts.slice(1)),
        query: query(url),
        headers: headers(request),
        body: parsedBody.value,
        context: Object.freeze({
          ...(context ?? {}),
          ...(parsedBody.raw ? { rawBody: parsedBody.raw } : {}),
        }),
      });
      return await jsonResponse(result, options, request);
    } catch (error) {
      await options.onError?.(error, request);
      return errorResponse(error, options);
    }
  };
}
