import { S3Client } from "@bradenmacdonald/s3-lite-client";
import type { S3BodyStorageConfig } from "./body-store.ts";

/** Shared request mechanics only; no writer lifetime or catalog policy. */
export function createS3TransportClient(
  config: S3BodyStorageConfig,
  bucket: string,
): S3Client {
  return new S3Client({
    endPoint: cleanEndpoint(config.endpoint),
    region: config.region.trim() || "auto",
    bucket,
    accessKey: config.accessKeyId,
    secretKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    pathStyle: config.pathStyle ?? true,
  });
}

function cleanEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

function requestErrorStatus(error: unknown): number | undefined {
  return (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
}

function requestErrorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export function isAbsentError(error: unknown): boolean {
  const status = requestErrorStatus(error);
  const code = requestErrorCode(error);
  return status === 404 || code === "NoSuchKey" || code === "NotFound";
}

export function isConditionalRace(error: unknown): boolean {
  const status = requestErrorStatus(error);
  return status === 404 || status === 409 || status === 412;
}

export function requestPayload(
  bytes: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

export const parseStrongEtag = (value: string | null): string | undefined => {
  const etag = value?.trim();
  return etag && !etag.startsWith("W/") && /^"[^"\r\n]+"$/.test(etag)
    ? etag
    : undefined;
};
