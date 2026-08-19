import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { createContentError } from "./errors.ts";
import type {
  AssetBodyHead,
  AssetBodySpill,
  AssetBodySpillHead,
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

function requestPayload(
  bytes: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
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

  const putObject = async (
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    headers: Record<string, string> = {},
  ): Promise<void> => {
    const response = await client.makeRequest({
      method: "PUT",
      objectName: key,
      bucketName: bucket,
      statusCode: 200,
      payload: requestPayload(bytes),
      headers: new Headers({
        "content-type": mediaType,
        "content-length": String(bytes.byteLength),
        ...headers,
      }),
    });
    if (!response.bodyUsed) await response.arrayBuffer();
    if (!response.ok) {
      throw createContentError(
        "asset_storage_unavailable",
        `Object upload failed with status ${response.status}.`,
      );
    }
  };

  const getObjectBytes = async (key: string): Promise<Uint8Array | null> => {
    try {
      const response = await client.getObject(key, { bucketName: bucket });
      if (response.status === 404) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const status =
        (error as { status?: number; statusCode?: number }).status ??
          (error as { statusCode?: number }).statusCode;
      const code = (error as { code?: string }).code;
      if (status === 404 || code === "NoSuchKey" || code === "NotFound") {
        return null;
      }
      throw error;
    }
  };

  const stagingPrefix = (key: string) => `${key}.progressive/`;
  const stagingMetaKey = (key: string) => `${stagingPrefix(key)}meta.json`;
  const stagingPartKey = (key: string, seq: number) =>
    `${stagingPrefix(key)}${String(seq).padStart(8, "0")}`;

  type S3SpillMeta = {
    mediaType: string;
    byteLength: number;
    discarded: number;
    reservationId: string;
    parts: { seq: number; offset: number; length: number }[];
  };

  const readSpillMeta = async (key: string): Promise<S3SpillMeta | null> => {
    const bytes = await getObjectBytes(stagingMetaKey(key));
    if (!bytes) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as S3SpillMeta;
    if (
      typeof parsed.mediaType !== "string" ||
      typeof parsed.byteLength !== "number" ||
      typeof parsed.discarded !== "number" ||
      !Array.isArray(parsed.parts)
    ) {
      throw createContentError(
        "asset_corrupted",
        "Progressive object staging metadata is invalid.",
      );
    }
    parsed.reservationId = typeof parsed.reservationId === "string"
      ? parsed.reservationId
      : "";
    return parsed;
  };

  const writeSpillMeta = (key: string, meta: S3SpillMeta) =>
    putObject(
      stagingMetaKey(key),
      new TextEncoder().encode(JSON.stringify(meta)),
      "application/json",
    );

  const deleteObject = (key: string) =>
    client.deleteObject(key, { bucketName: bucket });

  const spillHead = (
    key: string,
    meta: S3SpillMeta,
  ): AssetBodySpillHead =>
    Object.freeze({
      key,
      mediaType: meta.mediaType,
      byteLength: meta.byteLength,
      discarded: meta.discarded,
      reservationId: meta.reservationId,
    });

  const requireSpillMeta = async (key: string): Promise<S3SpillMeta> => {
    const meta = await readSpillMeta(key);
    if (!meta) {
      throw createContentError(
        "asset_not_found",
        "Progressive staging was not found.",
      );
    }
    return meta;
  };

  const requireOwner = (
    meta: S3SpillMeta,
    reservationId: string,
  ): void => {
    if (meta.reservationId !== reservationId) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this asset body.",
      );
    }
  };

  const spill: AssetBodySpill = {
    async reserve(input) {
      const existing = await readSpillMeta(input.key);
      if (existing) {
        if (existing.mediaType !== input.mediaType) {
          throw createContentError(
            "asset_conflict",
            "Progressive staging media type does not match the writer.",
          );
        }
        if (!input.takeover) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
          );
        }
        existing.reservationId = input.reservationId;
        await writeSpillMeta(input.key, existing);
        return spillHead(input.key, existing);
      }
      const created: S3SpillMeta = {
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        reservationId: input.reservationId,
        parts: [],
      };
      try {
        await putObject(
          stagingMetaKey(input.key),
          new TextEncoder().encode(JSON.stringify(created)),
          "application/json",
          { "if-none-match": "*" },
        );
      } catch (error) {
        const raced = await readSpillMeta(input.key);
        if (raced) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
            { cause: error },
          );
        }
        throw error;
      }
      return spillHead(input.key, created);
    },
    async head(key) {
      const meta = await readSpillMeta(key);
      return meta ? spillHead(key, meta) : null;
    },
    async append(input) {
      const existing = await requireSpillMeta(input.key);
      requireOwner(existing, input.reservationId);
      if (existing.mediaType !== input.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      const meta: S3SpillMeta = existing;
      if (input.bytes.byteLength > 0) {
        const seq = (meta.parts.at(-1)?.seq ?? -1) + 1;
        await putObject(
          stagingPartKey(input.key, seq),
          input.bytes,
          input.mediaType,
        );
        meta.parts.push({
          seq,
          offset: meta.byteLength,
          length: input.bytes.byteLength,
        });
        meta.byteLength += input.bytes.byteLength;
      }
      await writeSpillMeta(input.key, meta);
      return spillHead(input.key, meta);
    },
    async read(input) {
      const meta = await requireSpillMeta(input.key);
      const start = Math.max(input.offset, meta.discarded);
      const end = Math.min(input.end, meta.byteLength);
      if (end <= start) return new Uint8Array();
      const output = new Uint8Array(end - start);
      let cursor = 0;
      for (const part of meta.parts) {
        const partEnd = part.offset + part.length;
        if (partEnd <= start || part.offset >= end) continue;
        const bytes = await getObjectBytes(
          stagingPartKey(input.key, part.seq),
        );
        if (!bytes || bytes.byteLength !== part.length) {
          throw createContentError(
            "asset_corrupted",
            "Progressive object staging part is missing.",
          );
        }
        const from = Math.max(0, start - part.offset);
        const to = Math.min(part.length, end - part.offset);
        output.set(bytes.subarray(from, to), cursor);
        cursor += to - from;
      }
      return output;
    },
    async truncate(key, byteLength, reservationId) {
      const meta = await requireSpillMeta(key);
      requireOwner(meta, reservationId);
      if (byteLength < meta.discarded || byteLength > meta.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive truncate is outside the committed range.",
        );
      }
      const kept: S3SpillMeta["parts"] = [];
      for (const part of meta.parts) {
        if (part.offset >= byteLength) {
          await client.deleteObject(
            stagingPartKey(key, part.seq),
            { bucketName: bucket },
          );
          continue;
        }
        if (part.offset + part.length <= byteLength) {
          kept.push(part);
          continue;
        }
        const length = byteLength - part.offset;
        const bytes = await getObjectBytes(stagingPartKey(key, part.seq));
        if (!bytes) {
          throw createContentError(
            "asset_corrupted",
            "Progressive object staging part is missing.",
          );
        }
        await putObject(
          stagingPartKey(key, part.seq),
          bytes.subarray(0, length),
          meta.mediaType,
        );
        kept.push({ ...part, length });
      }
      meta.parts = kept;
      meta.byteLength = byteLength;
      await writeSpillMeta(key, meta);
      return spillHead(key, meta);
    },
    async discardPrefix(key, byteLength, reservationId) {
      const meta = await requireSpillMeta(key);
      requireOwner(meta, reservationId);
      if (byteLength < meta.discarded || byteLength > meta.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive discard is outside the committed range.",
        );
      }
      const kept: S3SpillMeta["parts"] = [];
      for (const part of meta.parts) {
        if (part.offset + part.length <= byteLength) {
          await client.deleteObject(
            stagingPartKey(key, part.seq),
            { bucketName: bucket },
          );
          continue;
        }
        kept.push(part);
      }
      meta.parts = kept;
      meta.discarded = byteLength;
      await writeSpillMeta(key, meta);
      return spillHead(key, meta);
    },
    async delete(key, reservationId) {
      const meta = await readSpillMeta(key);
      if (meta) {
        requireOwner(meta, reservationId);
        for (const part of meta.parts) {
          await deleteObject(stagingPartKey(key, part.seq));
        }
      }
      await deleteObject(stagingMetaKey(key));
    },
  };

  const store: AssetBodyStore = {
    kind: "object",
    backendId,
    async put(input) {
      let response: Response;
      try {
        response = await client.makeRequest({
          method: "PUT",
          objectName: input.key,
          bucketName: bucket,
          statusCode: 200,
          payload: requestPayload(input.bytes),
          headers: new Headers({
            "content-type": input.mediaType,
            "content-length": String(input.bytes.byteLength),
            "if-none-match": "*",
            "x-amz-meta-copilotz-sha256": input.digest.slice("sha256:".length),
            "x-amz-meta-copilotz-media-type": input.mediaType,
          }),
        });
      } catch (error) {
        // Conditional PUT is the existence probe. A preflight HEAD adds a full
        // network round trip to every new immutable object; on a conflict or
        // race, inspect the winner and preserve the same idempotency checks.
        const raced = await head(input.key);
        if (raced) {
          assertStored(input, raced);
          return raced;
        }
        throw error;
      }
      const responseStatus = response.status;
      const responseOk = response.ok;
      // GCS and S3 may return a response stream even for a zero-length PUT
      // result. The body is not part of the body-store contract, so drain it
      // immediately; retaining thousands of unread streams keeps transport
      // buffers and connections alive during large migrations. Draining also
      // lets the HTTP client reuse the connection.
      if (!response.bodyUsed) await response.arrayBuffer();
      if (!responseOk) {
        throw createContentError(
          "asset_storage_unavailable",
          `Object upload failed with status ${responseStatus}.`,
        );
      }
      /*
       * A successful signed PUT already authenticates the complete payload
       * hash, content length, media type, and canonical digest metadata sent
       * above. Returning that acknowledged representation avoids a redundant
       * HEAD round trip for every new immutable object. Conflicts still take
       * the HEAD path in the catch block so resumability verifies the existing
       * winner before reusing it.
       */
      const etagHeader = response.headers.get("etag");
      const etag = etagHeader?.replace(/^"|"$/g, "") || undefined;
      const lastModifiedHeader = response.headers.get("last-modified");
      const lastModified = lastModifiedHeader
        ? new Date(lastModifiedHeader).toISOString()
        : undefined;
      return Object.freeze({
        key: input.key,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
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
    spill,
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
