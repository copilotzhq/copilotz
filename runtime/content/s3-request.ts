/** Signed, bounded S3 requests. Conditional headers are part of the signature; bounded retries for idempotent reads. */
import { AwsClient } from "aws4fetch";
import { parseStrongEtag } from "./s3-transport.ts";
import type { S3BodyStorageConfig } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";

const PHYSICAL_MANIFEST_DECODE_BYTES = 4 * 1024 * 1024;

export type S3Request = Readonly<{
  method: "HEAD" | "GET" | "PUT" | "DELETE";
  objectName: string;
  headers?: HeadersInit;
  query?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
}>;
export type S3Response = Readonly<{
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}>;
export type S3Requester = (
  request: S3Request,
) => Promise<S3Response>;
const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
function unavailable(): never {
  throw createContentError(
    "asset_storage_unavailable",
    "Physical S3 request failed or exceeded its response bound.",
  );
}
export function createS3Requester(
  config: S3BodyStorageConfig,
  options: Readonly<
    {
      fetch?: typeof fetch;
      timeoutMs?: number;
      readRetries?: number;
      retryDelayMs?: number;
    }
  > = {},
): S3Requester {
  if (
    config.provider !== undefined && config.provider !== "s3" &&
    config.provider !== "gcs"
  ) throw new TypeError("Invalid S3 provider.");
  const endpoint = new URL(config.endpoint);
  const bucket = config.bucket.trim();
  const pathStyle = config.pathStyle ?? true;
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs ?? 30_000;
  const retries = options.readRetries ?? 3;
  const delay = options.retryDelayMs ?? 100;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (
    endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) ||
    !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(bucket) || bucket.includes("..") ||
    bucket.endsWith(".") ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 ||
    !Number.isSafeInteger(retries) || retries < 0 || retries > 8 ||
    !Number.isSafeInteger(delay) || delay < 0 || delay > 10_000
  ) {
    throw createContentError(
      "content_invalid",
      "Invalid physical S3 transport configuration.",
    );
  }
  const signer = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    service: "s3",
    region: config.region.trim() || "auto",
    retries: 0,
  });
  const attempt: S3Requester = async (input) => {
    const { method, objectName, maxResponseBytes } = input;
    const headers = new Headers(input.headers);
    if (method === "PUT" || method === "DELETE") {
      const match = headers.get("if-match"),
        absent = headers.get("if-none-match");
      const generation = headers.get("x-goog-if-generation-match");
      const guarded = config.provider === "gcs"
        ? generation !== null && /^(0|[1-9][0-9]{0,19})$/.test(generation) &&
          match === null && absent === null
        : method !== "DELETE" &&
          ((match === null && absent === "*") ||
            (absent === null && parseStrongEtag(match)));
      if (!guarded) {
        throw createContentError(
          "content_invalid",
          "Physical S3 writes require exactly one conditional guard.",
        );
      }
    }
    const supplied = input.body;
    if (
      supplied !== undefined &&
      (!(supplied instanceof Uint8Array) ||
        byteLength.call(supplied) > PHYSICAL_MANIFEST_DECODE_BYTES)
    ) {
      throw createContentError(
        "content_invalid",
        "Physical S3 payload exceeds its byte bound.",
      );
    }
    const body = supplied === undefined ? undefined : new Uint8Array(
      supplied.buffer,
      supplied.byteOffset,
      supplied.byteLength,
    );
    if (
      [...headers.keys()].some((key) =>
        ![
          "if-match",
          "if-none-match",
          "content-type",
          "range",
          "x-goog-if-generation-match",
          "x-goog-if-metageneration-match",
        ].includes(key)
      )
    ) {
      throw createContentError(
        "content_invalid",
        "Unsupported physical S3 request header.",
      );
    }
    if (
      !["HEAD", "GET", "PUT", "DELETE"].includes(method) ||
      !(objectName === "" && method === "GET" &&
          input.query?.["list-type"] === "2") &&
        (new TextEncoder().encode(objectName).length > 4096 ||
          /[\r\n]/.test(objectName) ||
          objectName.split("/").some((part) =>
            !part || part === "." || part === ".."
          )) ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0 ||
      maxResponseBytes > PHYSICAL_MANIFEST_DECODE_BYTES ||
      (method !== "PUT" && body !== undefined) ||
      (body?.byteLength ?? 0) > PHYSICAL_MANIFEST_DECODE_BYTES
    ) {
      throw createContentError(
        "content_invalid",
        "Invalid physical S3 request.",
      );
    }
    const url = new URL(endpoint);
    if (!pathStyle) url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `${
      endpoint.pathname.replace(/\+/g, "%2B").replace(/\/$/, "")
    }/${pathStyle ? `${bucket}/` : ""}${
      objectName.split("/").map(encodeURIComponent).join("/")
    }`;
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (
        !["list-type", "prefix", "continuation-token", "max-keys"].includes(key)
      ) throw new TypeError("Invalid S3 query.");
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      headers.set(
        "x-amz-content-sha256",
        (await digestContent(body ?? new Uint8Array())).slice(7),
      );
      const signed = await signer.sign(url, {
        method,
        headers,
        body: body as Uint8Array<ArrayBuffer> | undefined,
        signal: controller.signal,
        redirect: "error",
        aws: { allHeaders: true, signQuery: false },
      });
      // Signing can queue behind database/JSON work. Give the dispatched request
      // its full transport budget, independently for each retry.
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await send(signed);
      const limit = response.status >= 400
        ? Math.min(ERROR_RESPONSE_MAX_BYTES, PHYSICAL_MANIFEST_DECODE_BYTES)
        : maxResponseBytes;
      reader = response.body?.getReader();
      const declared = response.headers.get("content-length");
      // HEAD carries the object's size but deliberately has no response body.
      if (
        method !== "HEAD" && declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > limit)
      ) unavailable();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            complete = true;
            break;
          }
          total += result.value.byteLength;
          if (total > limit) unavailable();
          chunks.push(new Uint8Array(result.value));
        }
      } else complete = true;
      controller.signal.throwIfAborted();
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Object.freeze({
        status: response.status,
        headers: new Headers(response.headers),
        bytes,
      });
    } catch (cause) {
      // Only transport failures are retryable; response bounds remain hard errors.
      if (cause instanceof Error && cause.name === "CopilotzContentError") {
        throw cause;
      }
      throw Object.assign(
        new Error("Physical S3 transport failed.", { cause }),
        { retryableRead: true },
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
      try {
        if (reader && !complete) await reader.cancel();
      } catch {
        // An aborted reader may reject cancellation. The attempt already carries
        // the transport/bound error; cleanup must not turn it into a new failure.
      } finally {
        reader?.releaseLock();
      }
    }
  };
  return async (input) => {
    // Pin caller intent across asynchronous attempts, including conditional guards.
    input = {
      ...input,
      headers: new Headers(input.headers),
      ...(input.query ? { query: { ...input.query } } : {}),
    };
    const retryable = input.method === "HEAD" || input.method === "GET";
    for (let index = 0;; index++) {
      try {
        const response = await attempt(input);
        // 412 and all other version-guard failures are returned immediately.
        if (
          !retryable || index >= retries ||
          !(response.status === 429 || response.status >= 500)
        ) return response;
      } catch (error) {
        if (
          !retryable || index >= retries || !error ||
          typeof error !== "object" || !("retryableRead" in error)
        ) {
          if (error && typeof error === "object" && "retryableRead" in error) {
            unavailable();
          }
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delay * 2 ** index));
    }
  };
}
