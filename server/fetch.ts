import type {
  HttpApplication,
  HttpError,
  HttpRequest,
  HttpResponse,
} from "./http-types.ts";
import { isHttpObservation } from "./http-types.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";

export type HttpBodyPolicy = Readonly<{
  /** Hard byte cap enforced while consuming the request stream. */
  maxBytes: number;
  /** Optional bounded 413 error projection for the selected raw route. */
  tooLarge?: Readonly<{ code: string; message: string }>;
}>;

export type CreateHttpFetchHandlerOptions = Readonly<{
  /** Mount path for the compiled facade. */
  basePath?: string;
  /** Bounds bytes before authentication or authorization reads a cloned body. */
  requestBodyPolicy?: (request: Request) => HttpBodyPolicy;
  resolveContext?: (
    request: Request,
  ) =>
    | HttpRequest["context"]
    | Response
    | Promise<HttpRequest["context"] | Response>;
  /** Selects routes whose body is opaque bytes even when Content-Type is JSON. */
  rawBody?: (
    request: Request,
    context: HttpRequest["context"] | undefined,
  ) => boolean | HttpBodyPolicy;
  responseHeaders?: Readonly<Record<string, string>>;
  onError?: (error: unknown, request: Request) => void | Promise<void>;
}>;

export type HttpFetchHandler = (request: Request) => Promise<Response>;

const METHODS = new Set<HttpRequest["method"]>([
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

function query(url: URL): HttpRequest["query"] {
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

function rawBodyTooLarge(policy: HttpBodyPolicy): Error {
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

function boundRequest(
  request: Request,
  policy: HttpBodyPolicy,
): Request {
  if (!request.body) return request;
  const reader = request.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        total += value.byteLength;
        if (total > policy.maxBytes) {
          const error = rawBodyTooLarge(policy);
          await reader.cancel(error);
          reader.releaseLock();
          controller.error(error);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
  return new Request(request, { body, duplex: "half" } as RequestInit);
}

async function readBodyBytes(
  request: Request,
  policy: HttpBodyPolicy | undefined,
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
  rawPolicy: boolean | HttpBodyPolicy = false,
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
    typeof rawPolicy === "object" ? rawPolicy : { maxBytes: 1024 * 1024 },
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
  options: CreateHttpFetchHandlerOptions,
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

function jsonResponse(
  result: HttpResponse,
  options: CreateHttpFetchHandlerOptions,
  request: Request,
): Response {
  if (result.status === 204) {
    return new Response(null, {
      status: result.status,
      headers: responseHeaders(options, result.headers),
    });
  }
  if (result.data instanceof Response) return result.data;
  if (isHttpObservation(result.data)) {
    return applicationOutputsMultipartResponse(result.data, {
      headers: responseHeaders(options, result.headers),
      signal: request.signal,
    });
  }

  return new Response(
    JSON.stringify({
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.pageInfo ? { pageInfo: result.pageInfo } : {}),
    }),
    {
      status: result.status,
      headers: responseHeaders(options, result.headers),
    },
  );
}

function errorResponse(
  error: unknown,
  options: CreateHttpFetchHandlerOptions,
): Response {
  const typed = error as Partial<HttpError> & {
    retryAfterSeconds?: unknown;
  };
  const contentStatus: Record<string, number> = {
    asset_not_found: 404,
    asset_deleted: 410,
    asset_not_ready: 409,
    asset_conflict: 409,
    content_invalid: 400,
    content_unauthorized: 403,
  };
  const status = typeof typed?.status === "number" &&
      typed.status >= 400 && typed.status <= 599
    ? typed.status
    : contentStatus[typed?.code ?? ""] ?? 500;
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

/** Adapts the compiled HTTP application to the Web Fetch contract. */
export function createHttpFetchHandler(
  app: HttpApplication,
  options: CreateHttpFetchHandlerOptions = {},
): HttpFetchHandler {
  const base = basePath(options.basePath);
  return async (request) => {
    try {
      if (options.requestBodyPolicy) {
        request = boundRequest(request, options.requestBodyPolicy(request));
      }
      const method = request.method.toUpperCase();
      if (!METHODS.has(method as HttpRequest["method"])) {
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
        method: method as HttpRequest["method"],
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
    } finally {
      if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
    }
  };
}
