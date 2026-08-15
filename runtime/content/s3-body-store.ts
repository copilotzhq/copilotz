import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { createContentError } from "./errors.ts";
import type {
  AssetBodyHead,
  AssetBodyStore,
  PutAssetBodyInput,
  S3AssetStorageConfig,
} from "./body-store.ts";

function cleanEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

function metadataValue(
  metadata: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const target = key.toLowerCase();
  for (const [name, value] of Object.entries(metadata)) {
    if (name.toLowerCase() === target && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeDigest(
  value: string | undefined,
): `sha256:${string}` | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return /^sha256:[0-9a-f]{64}$/i.test(normalized)
    ? normalized.toLowerCase() as `sha256:${string}`
    : undefined;
}

function assertStored(input: PutAssetBodyInput, head: AssetBodyHead): void {
  if (
    head.byteLength !== input.bytes.byteLength ||
    head.digest !== input.digest ||
    head.mediaType !== input.mediaType
  ) {
    throw createContentError(
      "asset_conflict",
      "Stored object does not match the canonical asset body.",
    );
  }
}

/** Creates the default S3-compatible store, including GCS XML/HMAC usage. */
export function createS3AssetBodyStore(
  config: S3AssetStorageConfig,
): AssetBodyStore {
  const backendId = config.backendId.trim();
  const bucket = config.bucket.trim();
  if (!backendId || !bucket) {
    throw new TypeError("S3 backendId and bucket must be non-empty.");
  }
  const client = new S3Client({
    endPoint: cleanEndpoint(config.endpoint),
    region: config.region.trim() || "auto",
    bucket,
    accessKey: config.accessKeyId,
    secretKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    pathStyle: config.pathStyle ?? true,
  });

  const head = async (key: string): Promise<AssetBodyHead | null> => {
    try {
      const status = await client.statObject(key, { bucketName: bucket });
      const fields = status as unknown as Record<string, unknown>;
      const metadata = (fields.metadata ?? fields.headers ?? {}) as Record<
        string,
        string | undefined
      >;
      const byteLength = Number(
        fields.size ?? fields.contentLength ??
          metadataValue(metadata, "content-length"),
      );
      const mediaType = String(
        fields.contentType ?? metadataValue(metadata, "content-type") ??
          metadataValue(metadata, "x-amz-meta-copilotz-media-type") ??
          "application/octet-stream",
      );
      const digest = normalizeDigest(
        metadataValue(metadata, "x-amz-meta-copilotz-sha256") ??
          (typeof fields.digest === "string" ? fields.digest : undefined),
      );
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !digest) {
        throw createContentError(
          "asset_corrupted",
          "Object metadata is incomplete for a canonical asset body.",
        );
      }
      const lastModified = fields.lastModified instanceof Date
        ? fields.lastModified.toISOString()
        : typeof fields.lastModified === "string"
        ? new Date(fields.lastModified).toISOString()
        : undefined;
      const etag = typeof fields.etag === "string" ? fields.etag : undefined;
      return Object.freeze({
        key,
        byteLength,
        mediaType,
        digest,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    } catch (error) {
      const code = (error as { code?: string; status?: number }).code;
      const status =
        (error as { status?: number; statusCode?: number }).status ??
          (error as { statusCode?: number }).statusCode;
      if (status === 404 || code === "NoSuchKey" || code === "NotFound") {
        return null;
      }
      throw error;
    }
  };

  const store: AssetBodyStore = {
    kind: "object",
    backendId,
    async put(input) {
      const existing = await head(input.key);
      if (existing) {
        assertStored(input, existing);
        return existing;
      }
      const response = await client.makeRequest({
        method: "PUT",
        objectName: input.key,
        bucketName: bucket,
        statusCode: 200,
        payload: new Uint8Array(input.bytes),
        headers: new Headers({
          "content-type": input.mediaType,
          "content-length": String(input.bytes.byteLength),
          "if-none-match": "*",
          "x-amz-meta-copilotz-sha256": input.digest.slice("sha256:".length),
          "x-amz-meta-copilotz-media-type": input.mediaType,
        }),
      }).catch(async (error) => {
        const raced = await head(input.key);
        if (raced) return new Response(null, { status: 200 });
        throw error;
      });
      if (!response.ok) {
        throw createContentError(
          "asset_storage_unavailable",
          `Object upload failed with status ${response.status}.`,
        );
      }
      const stored = await head(input.key);
      if (!stored) {
        throw createContentError(
          "asset_storage_unavailable",
          "Uploaded object is not visible after completion.",
        );
      }
      assertStored(input, stored);
      return stored;
    },
    head,
    async read(key) {
      const response = await client.getObject(key, { bucketName: bucket });
      return new Uint8Array(await response.arrayBuffer());
    },
    async open(key) {
      const response = await client.getObject(key, { bucketName: bucket });
      if (!response.body) {
        throw createContentError(
          "asset_corrupted",
          "Object response has no body.",
        );
      }
      return response.body;
    },
    delete: (key) => client.deleteObject(key, { bucketName: bucket }),
    async *list(options = {}) {
      for await (
        const entry of client.listObjects({
          bucketName: bucket,
          prefix: options.prefix,
        })
      ) {
        const value = await head(entry.key);
        if (value) yield value;
      }
    },
  };
  return Object.freeze(store);
}
