import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import type {
  AbortBodyInput,
  AppendBodyInput,
  AppendResult,
  BodyHead,
  BodyStore,
  MutableBodyHead,
  PutBodyInput,
  ReadBodyRangeInput,
  ReserveBodyInput,
  S3BodyStorageConfig,
  WriterCapability,
} from "./body-store.ts";
import {
  bodyProtectionMs,
  bodyProtectionRemainingMs,
  bodyProtectionUntil,
  resolveBodyProtectionUntil,
  writerCapabilityFromHead,
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

function assertStored(input: PutBodyInput, head: BodyHead): void {
  if (
    head.bodyId !== input.bodyId ||
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

function skipStreamOffset(
  stream: ReadableStream<Uint8Array>,
  offset: number,
): ReadableStream<Uint8Array> {
  if (offset <= 0) return stream;
  let remaining = offset;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (remaining <= 0) {
          controller.enqueue(chunk);
          return;
        }
        if (chunk.byteLength <= remaining) {
          remaining -= chunk.byteLength;
          return;
        }
        const rest = chunk.subarray(remaining);
        remaining = 0;
        controller.enqueue(rest);
      },
    }),
  );
}

/** Creates the default S3-compatible store, including GCS XML/HMAC usage. */
export function createS3BodyStore(
  config: S3BodyStorageConfig,
): BodyStore {
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
  const protectionMs = bodyProtectionMs(config.protectionMs);

  const head = async (bodyId: string): Promise<BodyHead | null> => {
    try {
      const status = await client.statObject(bodyId, { bucketName: bucket });
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
        bodyId,
        state: "ready" as const,
        byteLength,
        mediaType,
        digest,
        maintenanceVersion: Number(
          metadataValue(metadata, "x-amz-meta-copilotz-maintenance-version") ??
            1,
        ),
        ...(metadataValue(metadata, "x-amz-meta-copilotz-protected-until")
          ? {
            protectedUntil: metadataValue(
              metadata,
              "x-amz-meta-copilotz-protected-until",
            )!,
          }
          : {}),
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
    writerGeneration: number;
    leaseExpiresAt: string;
    maintenanceVersion: number;
    parts: { seq: number; appendId: string; offset: number; length: number }[];
  };

  type ProgressiveBodyOps = Readonly<{
    reserve(input: ReserveBodyInput): Promise<WriterCapability>;
    head(bodyId: string): Promise<MutableBodyHead | null>;
    append(input: AppendBodyInput): Promise<AppendResult>;
    readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
    abort(input: AbortBodyInput): Promise<void>;
  }>;

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
    parsed.writerGeneration = typeof parsed.writerGeneration === "number"
      ? parsed.writerGeneration
      : 1;
    parsed.leaseExpiresAt = typeof parsed.leaseExpiresAt === "string"
      ? parsed.leaseExpiresAt
      : "";
    parsed.maintenanceVersion = typeof parsed.maintenanceVersion === "number"
      ? parsed.maintenanceVersion
      : 1;
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
    bodyId: string,
    meta: S3SpillMeta,
  ): MutableBodyHead =>
    Object.freeze({
      bodyId,
      state: "open" as const,
      mediaType: meta.mediaType,
      byteLength: meta.byteLength,
      discarded: meta.discarded,
      maintenanceVersion: meta.maintenanceVersion,
      writerGeneration: meta.writerGeneration,
      writerLeaseRemainingMs: bodyProtectionRemainingMs(meta.leaseExpiresAt),
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

  const progressive: ProgressiveBodyOps = {
    async reserve(input) {
      const reservationId = crypto.randomUUID();
      const existing = await readSpillMeta(input.bodyId);
      if (existing) {
        if (existing.mediaType !== input.mediaType) {
          throw createContentError(
            "asset_conflict",
            "Progressive staging media type does not match the writer.",
          );
        }
        if (
          input.expectedGeneration === undefined ||
          input.expectedGeneration !== existing.writerGeneration
        ) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
          );
        }
        if (bodyProtectionRemainingMs(existing.leaseExpiresAt) > 0) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer lease is still live for this asset body.",
          );
        }
        existing.reservationId = reservationId;
        existing.writerGeneration += 1;
        existing.maintenanceVersion += 1;
        existing.leaseExpiresAt = bodyProtectionUntil(protectionMs);
        await writeSpillMeta(input.bodyId, existing);
        return writerCapabilityFromHead(spillHead(input.bodyId, existing));
      }
      const created: S3SpillMeta = {
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        reservationId,
        writerGeneration: 1,
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
        maintenanceVersion: 1,
        parts: [],
      };
      try {
        await putObject(
          stagingMetaKey(input.bodyId),
          new TextEncoder().encode(JSON.stringify(created)),
          "application/json",
          { "if-none-match": "*" },
        );
      } catch (error) {
        const raced = await readSpillMeta(input.bodyId);
        if (raced) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
            { cause: error },
          );
        }
        throw error;
      }
      return writerCapabilityFromHead(spillHead(input.bodyId, created));
    },
    async head(bodyId) {
      const meta = await readSpillMeta(bodyId);
      return meta ? spillHead(bodyId, meta) : null;
    },
    async append(input) {
      const existing = await requireSpillMeta(input.writer.bodyId);
      requireOwner(existing, input.writer.reservationId);
      if (existing.mediaType !== input.writer.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      const meta: S3SpillMeta = existing;
      if (input.bytes.byteLength > 0) {
        const duplicate = meta.parts.find((part) =>
          part.appendId === input.appendId
        );
        if (duplicate) {
          const bytes = await getObjectBytes(
            stagingPartKey(input.writer.bodyId, duplicate.seq),
          );
          const same = duplicate.offset === input.expectedOffset &&
            bytes?.byteLength === input.bytes.byteLength &&
            bytes.every((byte, index) => byte === input.bytes[index]);
          if (!same) {
            throw createContentError(
              "asset_conflict",
              "Progressive append id was reused with different bytes.",
            );
          }
          return Object.freeze({
            startOffset: input.expectedOffset,
            endOffset: meta.byteLength,
            protection: Object.freeze({
              remainingMs: bodyProtectionRemainingMs(meta.leaseExpiresAt),
            }),
          });
        }
        if (input.expectedOffset !== meta.byteLength) {
          throw createContentError(
            "asset_conflict",
            "Progressive append expected offset does not match the body.",
          );
        }
        const seq = (meta.parts.at(-1)?.seq ?? -1) + 1;
        await putObject(
          stagingPartKey(input.writer.bodyId, seq),
          input.bytes,
          input.writer.mediaType,
        );
        meta.parts.push({
          seq,
          appendId: input.appendId,
          offset: meta.byteLength,
          length: input.bytes.byteLength,
        });
        meta.byteLength += input.bytes.byteLength;
      }
      meta.maintenanceVersion += 1;
      meta.leaseExpiresAt = bodyProtectionUntil(protectionMs);
      await writeSpillMeta(input.writer.bodyId, meta);
      return Object.freeze({
        startOffset: input.expectedOffset,
        endOffset: meta.byteLength,
        protection: Object.freeze({
          remainingMs: bodyProtectionRemainingMs(meta.leaseExpiresAt),
        }),
      });
    },
    async readRange(input) {
      const meta = await requireSpillMeta(input.bodyId);
      const start = Math.max(input.offset, meta.discarded);
      const end = Math.min(input.end, meta.byteLength);
      if (end <= start) return new Uint8Array();
      const output = new Uint8Array(end - start);
      let cursor = 0;
      for (const part of meta.parts) {
        const partEnd = part.offset + part.length;
        if (partEnd <= start || part.offset >= end) continue;
        const bytes = await getObjectBytes(
          stagingPartKey(input.bodyId, part.seq),
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
    async abort(input) {
      const meta = await readSpillMeta(input.writer.bodyId);
      if (meta) {
        requireOwner(meta, input.writer.reservationId);
        for (const part of meta.parts) {
          await deleteObject(stagingPartKey(input.writer.bodyId, part.seq));
        }
      }
      await deleteObject(stagingMetaKey(input.writer.bodyId));
    },
  };

  const store: BodyStore = {
    kind: "object",
    backendId,
    async put(input) {
      let response: Response;
      const protectedUntil = resolveBodyProtectionUntil(
        input.protectedUntil,
        protectionMs,
      );
      try {
        response = await client.makeRequest({
          method: "PUT",
          objectName: input.bodyId,
          bucketName: bucket,
          statusCode: 200,
          payload: requestPayload(input.bytes),
          headers: new Headers({
            "content-type": input.mediaType,
            "content-length": String(input.bytes.byteLength),
            "if-none-match": "*",
            "x-amz-meta-copilotz-sha256": input.digest.slice("sha256:".length),
            "x-amz-meta-copilotz-media-type": input.mediaType,
            "x-amz-meta-copilotz-maintenance-version": "1",
            "x-amz-meta-copilotz-protected-until": protectedUntil,
          }),
        });
      } catch (error) {
        // Conditional PUT is the existence probe. A preflight HEAD adds a full
        // network round trip to every new immutable object; on a conflict or
        // race, inspect the winner and preserve the same idempotency checks.
        const raced = await head(input.bodyId);
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
        bodyId: input.bodyId,
        state: "ready" as const,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        maintenanceVersion: 1,
        protectedUntil,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    },
    async head({ bodyId }) {
      return await head(bodyId) ?? await progressive.head(bodyId);
    },
    async read({ bodyId }) {
      const response = await client.getObject(bodyId, { bucketName: bucket });
      if (!response.body) {
        throw createContentError(
          "asset_corrupted",
          "Object response has no body.",
        );
      }
      return response.body;
    },
    async follow(input) {
      const ready = await head(input.bodyId);
      if (!ready) {
        const staged = await progressive.head(input.bodyId);
        if (!staged) {
          throw createContentError(
            "asset_not_found",
            "Body was not found in the configured object backend.",
          );
        }
        const bytes = await progressive.readRange({
          bodyId: input.bodyId,
          offset: Math.max(0, input.offset ?? 0),
          end: staged.byteLength,
        });
        return new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      return skipStreamOffset(
        await store.read({ bodyId: input.bodyId }),
        Math.max(0, input.offset ?? 0),
      );
    },
    reserve: progressive.reserve,
    append: progressive.append,
    async seal(input) {
      const current = await progressive.head(input.writer.bodyId);
      if (!current || current.reservationId !== input.writer.reservationId) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== current.byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match seal expectation.",
        );
      }
      const bytes = await progressive.readRange({
        bodyId: input.writer.bodyId,
        offset: 0,
        end: current.byteLength,
      });
      const digest = await digestContent(bytes);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw createContentError(
          "asset_conflict",
          "Progressive body digest does not match seal expectation.",
        );
      }
      const head = await store.put({
        bodyId: input.writer.bodyId,
        bytes,
        mediaType: current.mediaType,
        digest,
      });
      await progressive.abort(input);
      return head;
    },
    abort: progressive.abort,
    maintenance: {
      async list(input) {
        const states = new Set(input.states);
        const bodies: BodyHead[] = [];
        if (states.has("ready")) {
          for await (
            const entry of client.listObjects({
              bucketName: bucket,
            })
          ) {
            const value = await head(entry.key);
            if (value && value.bodyId > (input.after ?? "")) {
              bodies.push(value);
              if (bodies.length >= input.limit) break;
            }
          }
        }
        bodies.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
        return Object.freeze({
          bodies: Object.freeze(bodies),
          ...(bodies.length === input.limit
            ? { after: bodies[bodies.length - 1].bodyId }
            : {}),
        });
      },
      delete(input) {
        // Generic object metadata has no version independent from immutable
        // content ETags, so it cannot prove the Ready-body CAS contract.
        // Progressive staging is fenced separately by writer ownership.
        void input;
        return Promise.resolve(false);
      },
    },
  };
  return Object.freeze(store);
}
