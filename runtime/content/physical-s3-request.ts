/** Private signed, bounded S3 requests. No retries and no presigned authority. */
import { AwsClient } from "aws4fetch";
import { parseStrongEtag } from "./s3-transport.ts";
import type { S3BodyStorageConfig } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import { OWNER_PHYSICAL_OBJECT_ROOT } from "./physical-object-namespace.ts";
import { PHYSICAL_MANIFEST_DECODE_BYTES } from "./physical-object-manifest.ts";

export type PhysicalS3Request = Readonly<{
  method: "HEAD" | "GET" | "PUT";
  objectName: string;
  headers?: HeadersInit;
  body?: Uint8Array;
  maxResponseBytes: number;
}>;
export type PhysicalS3Response = Readonly<{
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}>;
export type PhysicalS3Requester = (
  request: PhysicalS3Request,
) => Promise<PhysicalS3Response>;
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
export function createPhysicalS3Requester(
  config: S3BodyStorageConfig,
  options: Readonly<{ fetch?: typeof fetch; timeoutMs?: number }> = {},
): PhysicalS3Requester {
  if (config.provider !== undefined && config.provider !== "s3") {
    throw createContentError(
      "content_invalid",
      "The physical progressive adapter requires S3 conditional writes.",
    );
  }
  const endpoint = new URL(config.endpoint);
  const bucket = config.bucket.trim();
  const pathStyle = config.pathStyle ?? true;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (
    endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) ||
    !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(bucket) || bucket.includes("..") ||
    bucket.endsWith(".") ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
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
  return async (input) => {
    const { method, objectName, maxResponseBytes } = input;
    const headers = new Headers(input.headers);
    if (method === "PUT") {
      const match = headers.get("if-match"),
        absent = headers.get("if-none-match");
      if (
        !((match === null && absent === "*") ||
          (absent === null && parseStrongEtag(match)))
      ) {
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
    const body = supplied === undefined ? undefined : new Uint8Array(supplied);
    if (
      [...headers.keys()].some((key) =>
        !["if-match", "if-none-match", "content-type", "range"].includes(key)
      )
    ) {
      throw createContentError(
        "content_invalid",
        "Unsupported physical S3 request header.",
      );
    }
    if (
      !["HEAD", "GET", "PUT"].includes(method) ||
      !objectName.startsWith(OWNER_PHYSICAL_OBJECT_ROOT) ||
      !/^[a-zA-Z0-9_./-]+$/.test(objectName) ||
      objectName.split("/").some((part) =>
        !part || part === "." || part === ".."
      ) ||
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
    }/${pathStyle ? `${bucket}/` : ""}${objectName}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        body,
        signal: controller.signal,
        redirect: "error",
        aws: { allHeaders: true, signQuery: false },
      });
      controller.signal.throwIfAborted();
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
    } catch {
      // Transport failure after dispatch leaves mutation outcome unknown.
      unavailable();
    } finally {
      controller.abort();
      clearTimeout(timer);
      try {
        if (reader && !complete) await reader.cancel();
      } catch {
        unavailable();
      } finally {
        reader?.releaseLock();
      }
    }
  };
}
