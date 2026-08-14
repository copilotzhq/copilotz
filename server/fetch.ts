import type {
  EventNativeApp,
  EventNativeAppError,
  EventNativeAppRequest,
  EventNativeAppResponse,
  EventNativeOutputStream,
} from "./event-native.ts";
import { isEventNativeOutputStream } from "./event-native.ts";
import type {
  AttachmentOutput,
  AttachmentStreamOutput,
} from "../runtime/attachments/index.ts";

export type EventNativeSseProjector = (
  output: AttachmentOutput,
  request: Request,
) =>
  | unknown
  | readonly unknown[]
  | null
  | Promise<unknown | readonly unknown[] | null>;

export type CreateEventNativeFetchHandlerOptions = Readonly<{
  /** Optional route prefix, for example /v2. */
  basePath?: string;
  resolveContext?: (
    request: Request,
  ) =>
    | EventNativeAppRequest["context"]
    | Promise<EventNativeAppRequest["context"]>;
  responseHeaders?: Readonly<Record<string, string>>;
  /** Optional versioned projection applied only to request-bound SSE output. */
  projectSseOutput?: EventNativeSseProjector;
  /** Optional SSE event name derived from a projected output value. */
  sseEventName?: (value: unknown) => string | undefined;
  onError?: (error: unknown, request: Request) => void | Promise<void>;
}>;

export type EventNativeFetchHandler = (request: Request) => Promise<Response>;

const METHODS = new Set<EventNativeAppRequest["method"]>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
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

async function body(request: Request): Promise<
  Readonly<{
    value: unknown;
    raw?: Uint8Array;
  }>
> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { value: undefined };
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (!raw.length) return { value: undefined, raw };
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    try {
      return { value: JSON.parse(new TextDecoder().decode(raw)), raw };
    } catch {
      throw Object.assign(new Error("Request body must contain valid JSON."), {
        status: 400,
        code: "invalid_json",
      });
    }
  }
  if (mediaType?.startsWith("text/") || mediaType === "application/xml") {
    return { value: new TextDecoder().decode(raw), raw };
  }
  return { value: raw, raw };
}

function responseHeaders(
  options: CreateEventNativeFetchHandlerOptions,
  featureHeaders?: HeadersInit,
): Headers {
  const result = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...(options.responseHeaders ?? {}),
  });
  if (!featureHeaders) return result;
  const supplied = new Headers(featureHeaders);
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

function jsonResponse(
  result: EventNativeAppResponse,
  options: CreateEventNativeFetchHandlerOptions,
  request: Request,
): Response {
  if (result.status === 204) {
    return new Response(null, {
      status: result.status,
      headers: responseHeaders(options, result.headers),
    });
  }
  if (result.data instanceof Response) return result.data;
  if (isEventNativeOutputStream(result.data)) {
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

function isAttachmentStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
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
  output: AttachmentOutput,
): unknown {
  if (!isAttachmentStreamOutput(output)) return output;
  return Object.freeze({
    type: output.type,
    streamId: output.streamId,
    participant: output.participant,
    mediaType: output.mediaType,
    ...(output.causationId ? { causationId: output.causationId } : {}),
    correlationId: output.correlationId,
    metadata: output.metadata,
  });
}

function sseFrame(value: unknown, event?: string): Uint8Array {
  const name = event?.replace(/[\r\n]/g, "").trim();
  return new TextEncoder().encode(
    `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
  );
}

function cancellationReason(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : String(reason ?? "cancelled");
}

function sseResponse(
  stream: EventNativeOutputStream,
  request: Request,
  options: CreateEventNativeFetchHandlerOptions,
  featureHeaders?: HeadersInit,
): Response {
  const reader = stream.outputs.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        const projected = options.projectSseOutput
          ? await options.projectSseOutput(next.value, request)
          : projectEventNativeSseOutput(next.value);
        if (projected === null || projected === undefined) return;
        const values = Array.isArray(projected) ? projected : [projected];
        for (const value of values) {
          controller.enqueue(sseFrame(value, options.sseEventName?.(value)));
        }
      } catch (error) {
        await stream.cancel(cancellationReason(error)).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await stream.cancel(cancellationReason(reason)).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: (() => {
      const headers = responseHeaders(options, featureHeaders);
      headers.set("cache-control", "no-cache");
      headers.set("content-type", "text/event-stream; charset=utf-8");
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
      const parsedBody = await body(request);
      const context = await options.resolveContext?.(request);
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
      return jsonResponse(result, options, request);
    } catch (error) {
      await options.onError?.(error, request);
      return errorResponse(error, options);
    }
  };
}
