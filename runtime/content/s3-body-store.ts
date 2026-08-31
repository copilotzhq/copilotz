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
  bodyHasBeenIdle,
  bodyProtectionMs,
  bodyProtectionRemainingMs,
  bodyProtectionUntil,
  latestBodyProtectionUntil,
  resolveBodyProtectionUntil,
  writerCapabilityFromHead,
} from "./body-store.ts";

type S3BodyStoreProvider = "s3" | "gcs";

type GcsReadyGuard = Readonly<{
  generation: string;
  metageneration: string;
}>;

type ReadyInspection = Readonly<{
  head: BodyHead;
  guard?: GcsReadyGuard;
}>;

function configuredProvider(
  config: S3BodyStorageConfig,
): S3BodyStoreProvider {
  const provider = config.provider ?? "s3";
  if (provider !== "s3" && provider !== "gcs") {
    throw new TypeError("S3 provider must be either 's3' or 'gcs'.");
  }
  return provider;
}

/** Whether this configuration implements the complete Ready-body CAS contract. */
export function s3BodyStoreReadyGarbageCollection(
  config: S3BodyStorageConfig,
): boolean {
  return configuredProvider(config) === "gcs";
}

function cleanEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

function copilotzMetadataValue(
  headers: Headers,
  key: string,
): string | undefined {
  return headers.get(`x-goog-meta-copilotz-${key}`) ??
    headers.get(`x-amz-meta-copilotz-${key}`) ?? undefined;
}

function metadataHeader(
  provider: S3BodyStoreProvider,
  key: string,
): string {
  return `x-${provider === "gcs" ? "goog" : "amz"}-meta-copilotz-${key}`;
}

function positiveInt64(value: string | null): string | undefined {
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n ? value : undefined;
  } catch {
    return undefined;
  }
}

function requestErrorStatus(error: unknown): number | undefined {
  return (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
}

function requestErrorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function isAbsentError(error: unknown): boolean {
  const status = requestErrorStatus(error);
  const code = requestErrorCode(error);
  return status === 404 || code === "NoSuchKey" || code === "NotFound";
}

function isConditionalRace(error: unknown): boolean {
  const status = requestErrorStatus(error);
  return status === 404 || status === 409 || status === 412;
}

function encodeCopySource(bucket: string, bodyId: string): string {
  return `/${encodeURIComponent(bucket)}/${
    bodyId.split("/").map(encodeURIComponent).join("/")
  }`;
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
  const provider = configuredProvider(config);
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

  const inspectReady = async (
    bodyId: string,
  ): Promise<ReadyInspection | null> => {
    try {
      const response = await client.makeRequest({
        method: "HEAD",
        objectName: bodyId,
        bucketName: bucket,
        statusCode: 200,
        returnBody: true,
      });
      if (!response.bodyUsed) await response.arrayBuffer();
      const lengthHeader = response.headers.get("content-length");
      const byteLength = lengthHeader === null ? NaN : Number(lengthHeader);
      const mediaType = response.headers.get("content-type") ??
        copilotzMetadataValue(response.headers, "media-type") ??
        "application/octet-stream";
      const digest = normalizeDigest(
        copilotzMetadataValue(response.headers, "sha256"),
      );
      const maintenanceVersion = Number(
        copilotzMetadataValue(response.headers, "maintenance-version") ?? 1,
      );
      const protectedUntil = copilotzMetadataValue(
        response.headers,
        "protected-until",
      );
      if (
        !Number.isSafeInteger(byteLength) || byteLength < 0 || !digest ||
        !Number.isSafeInteger(maintenanceVersion) || maintenanceVersion < 1 ||
        (protectedUntil !== undefined &&
          !Number.isFinite(Date.parse(protectedUntil)))
      ) {
        throw createContentError(
          "asset_corrupted",
          "Object metadata is incomplete for a canonical asset body.",
        );
      }
      const modifiedHeader = response.headers.get("last-modified");
      const modifiedAt = modifiedHeader ? Date.parse(modifiedHeader) : NaN;
      const lastModified = Number.isFinite(modifiedAt)
        ? new Date(modifiedAt).toISOString()
        : undefined;
      const etagHeader = response.headers.get("etag")?.trim();
      const etag = etagHeader?.startsWith('"') && etagHeader.endsWith('"')
        ? etagHeader.slice(1, -1)
        : etagHeader || undefined;
      const head = Object.freeze({
        bodyId,
        state: "ready" as const,
        byteLength,
        mediaType,
        digest,
        maintenanceVersion,
        ...(protectedUntil ? { protectedUntil } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
      const generation = provider === "gcs"
        ? positiveInt64(response.headers.get("x-goog-generation"))
        : undefined;
      const metageneration = provider === "gcs"
        ? positiveInt64(response.headers.get("x-goog-metageneration"))
        : undefined;
      return Object.freeze({
        head,
        ...(generation && metageneration
          ? {
            guard: Object.freeze({ generation, metageneration }),
          }
          : {}),
      });
    } catch (error) {
      if (isAbsentError(error)) return null;
      throw error;
    }
  };

  const head = async (bodyId: string): Promise<BodyHead | null> =>
    (await inspectReady(bodyId))?.head ?? null;

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
      returnBody: true,
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

  const renewReady = async (
    input: PutBodyInput,
    current: ReadyInspection,
    protectedUntil: string,
  ): Promise<ReadyInspection | null> => {
    if (provider !== "gcs" || !current.guard) {
      throw createContentError(
        "asset_storage_unavailable",
        "GCS Ready-body coordination requires generation and metageneration headers.",
      );
    }
    const maintenanceVersion = current.head.maintenanceVersion + 1;
    if (!Number.isSafeInteger(maintenanceVersion)) {
      throw createContentError(
        "asset_corrupted",
        "Ready-body maintenance version cannot be advanced safely.",
      );
    }
    const { generation, metageneration } = current.guard;
    try {
      const response = await client.makeRequest({
        method: "PUT",
        objectName: input.bodyId,
        bucketName: bucket,
        statusCode: 200,
        returnBody: true,
        headers: new Headers({
          "content-type": input.mediaType,
          "x-goog-copy-source": encodeCopySource(bucket, input.bodyId),
          "x-goog-copy-source-generation": generation,
          "x-goog-copy-source-if-generation-match": generation,
          "x-goog-copy-source-if-metageneration-match": metageneration,
          "x-goog-if-generation-match": generation,
          "x-goog-if-metageneration-match": metageneration,
          "x-goog-metadata-directive": "REPLACE",
          [metadataHeader(provider, "sha256")]: input.digest.slice(
            "sha256:".length,
          ),
          [metadataHeader(provider, "media-type")]: input.mediaType,
          [metadataHeader(provider, "maintenance-version")]: String(
            maintenanceVersion,
          ),
          [metadataHeader(provider, "protected-until")]: protectedUntil,
        }),
      });
      if (!response.bodyUsed) await response.arrayBuffer();
    } catch (error) {
      if (isConditionalRace(error)) return null;
      throw error;
    }

    // Verify both the metadata replacement and the storage CAS identity. This
    // fails closed for XML-compatible services that accept but ignore GCS's
    // generation protocol.
    const verified = await inspectReady(input.bodyId);
    if (!verified?.guard) {
      throw createContentError(
        "asset_storage_unavailable",
        "GCS Ready-body renewal did not return a trustworthy version guard.",
      );
    }
    assertStored(input, verified.head);
    const verifiedProtection = verified.head.protectedUntil
      ? Date.parse(verified.head.protectedUntil)
      : NaN;
    if (
      verified.head.maintenanceVersion < maintenanceVersion ||
      !Number.isFinite(verifiedProtection) ||
      verifiedProtection < Date.parse(protectedUntil) ||
      (verified.guard.generation === generation &&
        verified.guard.metageneration === metageneration)
    ) {
      throw createContentError(
        "asset_storage_unavailable",
        "GCS Ready-body renewal did not atomically advance its maintenance metadata.",
      );
    }
    return verified;
  };

  const acquireExistingReady = async (
    input: PutBodyInput,
    requestedProtection: string,
    initial: ReadyInspection,
  ): Promise<BodyHead | null> => {
    let current = initial;
    for (let attempt = 0; attempt < 8; attempt++) {
      assertStored(input, current.head);
      if (provider !== "gcs") return current.head;
      if (!current.guard) {
        throw createContentError(
          "asset_storage_unavailable",
          "GCS Ready-body coordination requires generation and metageneration headers.",
        );
      }
      const protectedUntil = latestBodyProtectionUntil(
        current.head.protectedUntil,
        requestedProtection,
      );
      const observedVersion = current.head.maintenanceVersion;
      const renewed = await renewReady(input, current, protectedUntil);
      if (renewed) return renewed.head;

      const raced = await inspectReady(input.bodyId);
      if (!raced) return null;
      assertStored(input, raced.head);
      const racedProtection = raced.head.protectedUntil
        ? Date.parse(raced.head.protectedUntil)
        : NaN;
      if (
        raced.head.maintenanceVersion > observedVersion &&
        Number.isFinite(racedProtection) &&
        racedProtection >= Date.parse(requestedProtection)
      ) {
        // A concurrent acquisition advanced the same immutable body and covers
        // this caller's non-shortening protection requirement.
        return raced.head;
      }
      current = raced;
    }
    throw createContentError(
      "asset_storage_unavailable",
      "GCS Ready-body protection renewal remained contended.",
    );
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
  const stagingPartsPrefix = (key: string) => `${stagingPrefix(key)}parts/`;
  const stagingWriterPartsPrefix = (
    bodyId: string,
    writerGeneration: number,
    reservationId: string,
  ) => `${stagingPartsPrefix(bodyId)}g${writerGeneration}/r${reservationId}/`;
  const legacyStagingPartKey = (key: string, seq: number) =>
    `${stagingPrefix(key)}${String(seq).padStart(8, "0")}`;

  // Metadata is the sole mutable authority. Every transition is conditional:
  // GCS uses generation+metageneration and S3 uses a strong, changing ETag.
  // Parts are immutable and isolated by writer generation/reservation, so a
  // stale request may leave an orphan but cannot overwrite accepted bytes.
  type SpillState = "open" | "sealing" | "aborting";

  type S3SpillPart = Readonly<{
    seq: number;
    appendId: string;
    offset: number;
    length: number;
    key: string;
  }>;

  type S3SpillMeta = Readonly<{
    state: SpillState;
    mediaType: string;
    byteLength: number;
    discarded: number;
    reservationId: string;
    writerGeneration: number;
    leaseExpiresAt: string;
    maintenanceVersion: number;
    parts: readonly S3SpillPart[];
    sealedDigest?: `sha256:${string}`;
  }>;

  type SpillGuard =
    | Readonly<{
      kind: "gcs";
      generation: string;
      metageneration: string;
    }>
    | Readonly<{ kind: "s3"; etag: string }>;

  type SpillInspection = Readonly<{
    meta: S3SpillMeta;
    guard: SpillGuard;
    lastModified?: string;
  }>;

  type ProgressiveBodyOps = Readonly<{
    reserve(input: ReserveBodyInput): Promise<WriterCapability>;
    head(bodyId: string): Promise<MutableBodyHead | null>;
    append(input: AppendBodyInput): Promise<AppendResult>;
    readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
    abort(input: AbortBodyInput): Promise<void>;
  }>;

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  // Seal latency benefits from parallel object reads, while a fixed bound
  // prevents one large stream from exhausting the host connection pool.
  const MAX_PARALLEL_PART_REQUESTS = 8;

  const unavailableCoordination = (message: string, cause?: unknown) =>
    createContentError(
      "asset_storage_unavailable",
      message,
      cause === undefined ? {} : { cause },
    );

  const parseStrongEtag = (value: string | null): string | undefined => {
    const etag = value?.trim();
    return etag && !etag.startsWith("W/") && /^"[^"\r\n]+"$/.test(etag)
      ? etag
      : undefined;
  };

  const sameGuard = (left: SpillGuard, right: SpillGuard): boolean =>
    left.kind === "gcs" && right.kind === "gcs"
      ? left.generation === right.generation &&
        left.metageneration === right.metageneration
      : left.kind === "s3" && right.kind === "s3" &&
        left.etag === right.etag;

  const spillGuard = (headers: Headers): SpillGuard | undefined => {
    if (provider === "gcs") {
      const generation = positiveInt64(headers.get("x-goog-generation"));
      const metageneration = positiveInt64(
        headers.get("x-goog-metageneration"),
      );
      return generation && metageneration
        ? Object.freeze({ kind: "gcs", generation, metageneration })
        : undefined;
    }
    const etag = parseStrongEtag(headers.get("etag"));
    return etag ? Object.freeze({ kind: "s3", etag }) : undefined;
  };

  const spillConditionalHeaders = (guard: SpillGuard): Headers =>
    guard.kind === "gcs"
      ? new Headers({
        "x-goog-if-generation-match": guard.generation,
        "x-goog-if-metageneration-match": guard.metageneration,
      })
      : new Headers({ "if-match": guard.etag });

  const spillCreateHeaders = (): Record<string, string> =>
    provider === "gcs"
      ? { "x-goog-if-generation-match": "0" }
      : { "if-none-match": "*" };

  const invalidSpillMeta = (cause?: unknown) =>
    createContentError(
      "asset_corrupted",
      "Progressive object staging metadata is invalid.",
      cause === undefined ? {} : { cause },
    );

  const advanceSpillCounter = (value: number): number => {
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
      throw invalidSpillMeta();
    }
    return value + 1;
  };

  const parseSpillMeta = (bodyId: string, bytes: Uint8Array): S3SpillMeta => {
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(bytes));
    } catch (error) {
      throw invalidSpillMeta(error);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidSpillMeta();
    }
    const parsed = value as Record<string, unknown>;
    const state = parsed.state === undefined ? "open" : parsed.state;
    const writerGeneration = parsed.writerGeneration;
    const maintenanceVersion = parsed.maintenanceVersion;
    const byteLength = parsed.byteLength;
    const discarded = parsed.discarded;
    const reservationId = parsed.reservationId;
    const leaseExpiresAt = parsed.leaseExpiresAt;
    const partsValue = parsed.parts;
    const sealedDigest = parsed.sealedDigest === undefined
      ? undefined
      : normalizeDigest(String(parsed.sealedDigest));
    if (
      (state !== "open" && state !== "sealing" && state !== "aborting") ||
      typeof parsed.mediaType !== "string" || parsed.mediaType.length === 0 ||
      !Number.isSafeInteger(byteLength) || (byteLength as number) < 0 ||
      !Number.isSafeInteger(discarded) || (discarded as number) < 0 ||
      (discarded as number) > (byteLength as number) ||
      typeof reservationId !== "string" || reservationId.length === 0 ||
      reservationId.length > 512 ||
      !Number.isSafeInteger(writerGeneration) ||
      (writerGeneration as number) < 1 ||
      typeof leaseExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(leaseExpiresAt)) ||
      !Number.isSafeInteger(maintenanceVersion) ||
      (maintenanceVersion as number) < 1 ||
      !Array.isArray(partsValue) || partsValue.length > 1_000_000 ||
      (parsed.sealedDigest !== undefined && !sealedDigest) ||
      (sealedDigest !== undefined && state !== "sealing")
    ) {
      throw invalidSpillMeta();
    }

    const parts: S3SpillPart[] = [];
    const appendIds = new Set<string>();
    const keys = new Set<string>();
    let expectedOffset = 0;
    let previousSeq = -1;
    for (const rawPart of partsValue) {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
        throw invalidSpillMeta();
      }
      const part = rawPart as Record<string, unknown>;
      const seq = part.seq;
      const appendId = part.appendId;
      const offset = part.offset;
      const length = part.length;
      const legacyKey = Number.isSafeInteger(seq)
        ? legacyStagingPartKey(bodyId, seq as number)
        : "";
      const key = part.key === undefined ? legacyKey : part.key;
      if (
        !Number.isSafeInteger(seq) || (seq as number) < 0 ||
        (seq as number) <= previousSeq ||
        typeof appendId !== "string" || appendId.length === 0 ||
        appendId.length > 1024 || appendIds.has(appendId) ||
        !Number.isSafeInteger(offset) || offset !== expectedOffset ||
        !Number.isSafeInteger(length) || (length as number) <= 0 ||
        typeof key !== "string" || keys.has(key) ||
        (key !== legacyKey && !key.startsWith(stagingPartsPrefix(bodyId)))
      ) {
        throw invalidSpillMeta();
      }
      previousSeq = seq as number;
      expectedOffset += length as number;
      if (!Number.isSafeInteger(expectedOffset)) throw invalidSpillMeta();
      appendIds.add(appendId);
      keys.add(key);
      parts.push(Object.freeze({
        seq: seq as number,
        appendId,
        offset: offset as number,
        length: length as number,
        key,
      }));
    }
    if (expectedOffset !== byteLength) throw invalidSpillMeta();
    return Object.freeze({
      state,
      mediaType: parsed.mediaType,
      byteLength: byteLength as number,
      discarded: discarded as number,
      reservationId,
      writerGeneration: writerGeneration as number,
      leaseExpiresAt,
      maintenanceVersion: maintenanceVersion as number,
      parts: Object.freeze(parts),
      ...(sealedDigest ? { sealedDigest } : {}),
    });
  };

  const readSpillInspection = async (
    bodyId: string,
  ): Promise<SpillInspection | null> => {
    try {
      const response = await client.makeRequest({
        method: "GET",
        objectName: stagingMetaKey(bodyId),
        bucketName: bucket,
        statusCode: 200,
        returnBody: true,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const guard = spillGuard(response.headers);
      if (!guard) {
        throw unavailableCoordination(
          provider === "gcs"
            ? "GCS progressive coordination requires generation and metageneration headers."
            : "S3 progressive coordination requires a strong object ETag.",
        );
      }
      const modifiedHeader = response.headers.get("last-modified");
      const modifiedAt = modifiedHeader ? Date.parse(modifiedHeader) : NaN;
      return Object.freeze({
        meta: parseSpillMeta(bodyId, bytes),
        guard,
        ...(Number.isFinite(modifiedAt)
          ? { lastModified: new Date(modifiedAt).toISOString() }
          : {}),
      });
    } catch (error) {
      if (isAbsentError(error)) return null;
      throw error;
    }
  };

  const sameSpillMeta = (left: S3SpillMeta, right: S3SpillMeta): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

  const casSpillMeta = async (
    bodyId: string,
    current: SpillInspection,
    candidate: S3SpillMeta,
  ): Promise<SpillInspection | null> => {
    try {
      const response = await client.makeRequest({
        method: "PUT",
        objectName: stagingMetaKey(bodyId),
        bucketName: bucket,
        statusCode: 200,
        payload: requestPayload(textEncoder.encode(JSON.stringify(candidate))),
        returnBody: true,
        headers: new Headers({
          "content-type": "application/json",
          ...Object.fromEntries(spillConditionalHeaders(current.guard)),
        }),
      });
      if (!response.bodyUsed) await response.arrayBuffer();
    } catch (error) {
      if (isConditionalRace(error)) return null;
      throw unavailableCoordination(
        "The object backend rejected progressive conditional metadata update.",
        error,
      );
    }
    const verified = await readSpillInspection(bodyId);
    if (!verified) {
      throw unavailableCoordination(
        "Progressive metadata disappeared after a successful conditional update.",
      );
    }
    if (sameGuard(current.guard, verified.guard)) {
      throw unavailableCoordination(
        "The object backend did not advance the progressive metadata CAS identity.",
      );
    }
    return sameSpillMeta(candidate, verified.meta) ? verified : null;
  };

  const deleteObject = async (key: string): Promise<void> => {
    try {
      await client.deleteObject(key, { bucketName: bucket });
    } catch (error) {
      if (!isAbsentError(error)) throw error;
    }
  };

  const mapBounded = async <Input, Output>(
    values: readonly Input[],
    limit: number,
    mapper: (value: Input, index: number) => Promise<Output>,
  ): Promise<Output[]> => {
    const output = new Array<Output>(values.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await mapper(values[index], index);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(limit, values.length) },
        () => worker(),
      ),
    );
    return output;
  };

  const deleteFencedSpillParts = async (
    bodyId: string,
    meta: S3SpillMeta,
  ): Promise<void> => {
    const keys = new Set(meta.parts.map((part) => part.key));
    const writerPrefix = stagingWriterPartsPrefix(
      bodyId,
      meta.writerGeneration,
      meta.reservationId,
    );
    for await (
      const entry of client.listObjects({
        bucketName: bucket,
        prefix: writerPrefix,
      })
    ) {
      keys.add(entry.key);
    }
    await mapBounded(
      [...keys],
      MAX_PARALLEL_PART_REQUESTS,
      (key) => deleteObject(key),
    );
  };

  const protectedSpillPart = (
    bodyId: string,
    meta: S3SpillMeta | undefined,
    key: string,
  ): boolean => {
    if (!meta) return false;
    return meta.parts.some((part) => part.key === key) ||
      key.startsWith(stagingWriterPartsPrefix(
        bodyId,
        meta.writerGeneration,
        meta.reservationId,
      ));
  };

  const orphanSpillParts = async (
    bodyId: string,
    idleForMs: number,
  ): Promise<readonly string[]> => {
    const before = await readSpillInspection(bodyId);
    const entries: Array<Readonly<{ key: string; lastModified?: string }>> = [];
    for await (
      const entry of client.listObjects({
        bucketName: bucket,
        prefix: stagingPrefix(bodyId),
      })
    ) {
      if (entry.key === stagingMetaKey(bodyId)) continue;
      entries.push(Object.freeze({
        key: entry.key,
        lastModified: entry.lastModified.toISOString(),
      }));
    }
    const after = await readSpillInspection(bodyId);
    return Object.freeze(
      entries.filter((entry) =>
        bodyHasBeenIdle(entry.lastModified, idleForMs) &&
        !protectedSpillPart(bodyId, before?.meta, entry.key) &&
        !protectedSpillPart(bodyId, after?.meta, entry.key)
      ).map((entry) => entry.key),
    );
  };

  const deleteSpillMeta = async (
    bodyId: string,
    current: SpillInspection,
  ): Promise<boolean> => {
    try {
      const response = await client.makeRequest({
        method: "DELETE",
        objectName: stagingMetaKey(bodyId),
        bucketName: bucket,
        statusCode: 204,
        returnBody: true,
        headers: spillConditionalHeaders(current.guard),
      });
      if (!response.bodyUsed) await response.arrayBuffer();
      return true;
    } catch (error) {
      if (isConditionalRace(error)) return false;
      throw error;
    }
  };

  const cleanupFencedSpill = async (
    bodyId: string,
    current: SpillInspection,
  ): Promise<void> => {
    await deleteFencedSpillParts(bodyId, current.meta);
    if (await deleteSpillMeta(bodyId, current)) return;
    const raced = await readSpillInspection(bodyId);
    if (!raced) return;
    if (
      raced.meta.state !== current.meta.state ||
      raced.meta.reservationId !== current.meta.reservationId ||
      raced.meta.writerGeneration !== current.meta.writerGeneration
    ) {
      throw createContentError(
        "asset_conflict",
        "Progressive cleanup lost its fenced metadata ownership.",
      );
    }
    throw unavailableCoordination(
      "Progressive cleanup remained contended and can be retried safely.",
    );
  };

  const spillHead = (
    bodyId: string,
    meta: S3SpillMeta,
  ): MutableBodyHead => {
    const common = {
      bodyId,
      mediaType: meta.mediaType,
      byteLength: meta.byteLength,
      discarded: meta.discarded,
      maintenanceVersion: meta.maintenanceVersion,
      reservationId: meta.reservationId,
    };
    if (meta.state === "aborting") {
      return Object.freeze({ ...common, state: "aborted" as const });
    }
    return Object.freeze({
      ...common,
      state: meta.state,
      writerGeneration: meta.writerGeneration,
      writerLeaseRemainingMs: bodyProtectionRemainingMs(meta.leaseExpiresAt),
    });
  };

  const requireSpillInspection = async (
    bodyId: string,
  ): Promise<SpillInspection> => {
    const inspection = await readSpillInspection(bodyId);
    if (!inspection) {
      throw createContentError(
        "asset_not_found",
        "Progressive staging was not found.",
      );
    }
    return inspection;
  };

  const requireOwner = (
    meta: S3SpillMeta,
    writer: WriterCapability,
  ): void => {
    if (
      meta.reservationId !== writer.reservationId ||
      meta.writerGeneration !== writer.generation ||
      meta.mediaType !== writer.mediaType
    ) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this asset body.",
      );
    }
  };

  const requireOpen = (meta: S3SpillMeta): void => {
    if (meta.state !== "open") {
      throw createContentError(
        "asset_conflict",
        "Progressive body is no longer open for mutation.",
      );
    }
  };

  const stagingPartKey = async (
    bodyId: string,
    meta: S3SpillMeta,
    seq: number,
    appendId: string,
  ): Promise<string> => {
    const appendDigest = await digestContent(textEncoder.encode(appendId));
    return `${
      stagingWriterPartsPrefix(
        bodyId,
        meta.writerGeneration,
        meta.reservationId,
      )
    }${String(seq).padStart(8, "0")}-${appendDigest.slice("sha256:".length)}`;
  };

  const putSpillPart = async (
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<void> => {
    try {
      await putObject(key, bytes, mediaType, spillCreateHeaders());
      return;
    } catch (error) {
      if (!isConditionalRace(error)) {
        throw unavailableCoordination(
          "The object backend rejected create-only progressive staging parts.",
          error,
        );
      }
    }
    const existing = await getObjectBytes(key);
    if (
      existing?.byteLength === bytes.byteLength &&
      existing.every((byte, index) => byte === bytes[index])
    ) {
      return;
    }
    throw createContentError(
      "asset_conflict",
      "Progressive staging part already exists with different bytes.",
    );
  };

  const readSpillPart = async (part: S3SpillPart): Promise<Uint8Array> => {
    const bytes = await getObjectBytes(part.key);
    if (!bytes || bytes.byteLength !== part.length) {
      throw createContentError(
        "asset_corrupted",
        "Progressive object staging part is missing or truncated.",
      );
    }
    return bytes;
  };

  const readSpillRange = async (
    meta: S3SpillMeta,
    input: ReadBodyRangeInput,
  ): Promise<Uint8Array> => {
    if (meta.state === "aborting") {
      throw createContentError(
        "asset_conflict",
        "Aborted progressive staging cannot be read.",
      );
    }
    const start = Math.max(input.offset, meta.discarded);
    const end = Math.min(input.end, meta.byteLength);
    if (end <= start) return new Uint8Array();
    const relevant = meta.parts.filter((part) =>
      part.offset + part.length > start && part.offset < end
    );
    const chunks = await mapBounded(
      relevant,
      MAX_PARALLEL_PART_REQUESTS,
      (part) => readSpillPart(part),
    );
    const output = new Uint8Array(end - start);
    for (let index = 0; index < relevant.length; index++) {
      const part = relevant[index];
      const from = Math.max(0, start - part.offset);
      const to = Math.min(part.length, end - part.offset);
      output.set(
        chunks[index].subarray(from, to),
        Math.max(0, part.offset - start),
      );
    }
    return output;
  };

  const appendResult = (
    input: AppendBodyInput,
    meta: S3SpillMeta,
  ): AppendResult =>
    Object.freeze({
      startOffset: input.expectedOffset,
      endOffset: meta.byteLength,
      protection: Object.freeze({
        remainingMs: bodyProtectionRemainingMs(meta.leaseExpiresAt),
      }),
    });

  const findIdenticalAppend = async (
    meta: S3SpillMeta,
    input: AppendBodyInput,
  ): Promise<boolean> => {
    const duplicate = meta.parts.find((part) =>
      part.appendId === input.appendId
    );
    if (!duplicate) return false;
    const bytes = await readSpillPart(duplicate);
    const same = duplicate.offset === input.expectedOffset &&
      bytes.byteLength === input.bytes.byteLength &&
      bytes.every((byte, index) => byte === input.bytes[index]);
    if (!same) {
      throw createContentError(
        "asset_conflict",
        "Progressive append id was reused with different bytes.",
      );
    }
    return true;
  };

  const progressive: ProgressiveBodyOps = {
    async reserve(input) {
      const reservationId = crypto.randomUUID();
      const existing = await readSpillInspection(input.bodyId);
      const ready = await inspectReady(input.bodyId);
      if (existing) {
        if (existing.meta.state === "aborting") {
          throw createContentError(
            "asset_conflict",
            "An aborting progressive body cannot be taken over.",
          );
        }
        if (existing.meta.state === "open" && ready) {
          throw createContentError(
            "asset_conflict",
            "A Ready body conflicts with open progressive staging.",
          );
        }
        if (
          existing.meta.state === "sealing" && ready &&
          (!existing.meta.sealedDigest ||
            ready.head.byteLength !== existing.meta.byteLength ||
            ready.head.mediaType !== existing.meta.mediaType ||
            ready.head.digest !== existing.meta.sealedDigest)
        ) {
          throw createContentError(
            "asset_conflict",
            "Ready body does not match the frozen progressive staging.",
          );
        }
        if (existing.meta.mediaType !== input.mediaType) {
          throw createContentError(
            "asset_conflict",
            "Progressive staging media type does not match the writer.",
          );
        }
        if (
          input.expectedGeneration === undefined ||
          input.expectedGeneration !== existing.meta.writerGeneration
        ) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
          );
        }
        if (bodyProtectionRemainingMs(existing.meta.leaseExpiresAt) > 0) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer lease is still live for this asset body.",
          );
        }
        const candidate: S3SpillMeta = Object.freeze({
          ...existing.meta,
          reservationId,
          writerGeneration: advanceSpillCounter(
            existing.meta.writerGeneration,
          ),
          maintenanceVersion: advanceSpillCounter(
            existing.meta.maintenanceVersion,
          ),
          leaseExpiresAt: bodyProtectionUntil(protectionMs),
        });
        const committed = await casSpillMeta(
          input.bodyId,
          existing,
          candidate,
        );
        if (committed) {
          return writerCapabilityFromHead(
            spillHead(input.bodyId, committed.meta),
          );
        }
        const raced = await readSpillInspection(input.bodyId);
        if (
          raced?.meta.state === existing.meta.state &&
          raced.meta.reservationId === reservationId &&
          raced.meta.writerGeneration === candidate.writerGeneration
        ) {
          return writerCapabilityFromHead(spillHead(input.bodyId, raced.meta));
        }
        throw createContentError(
          "asset_conflict",
          "Another progressive writer won the takeover race.",
        );
      }
      if (ready) {
        throw createContentError(
          "asset_conflict",
          "A Ready body already exists at this progressive body id.",
        );
      }
      const created: S3SpillMeta = {
        state: "open",
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        reservationId,
        writerGeneration: 1,
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
        maintenanceVersion: 1,
        parts: Object.freeze([]),
      };
      try {
        await putObject(
          stagingMetaKey(input.bodyId),
          textEncoder.encode(JSON.stringify(created)),
          "application/json",
          spillCreateHeaders(),
        );
      } catch (error) {
        const raced = await readSpillInspection(input.bodyId);
        if (raced) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this asset body.",
            { cause: error },
          );
        }
        throw unavailableCoordination(
          "The object backend rejected progressive conditional creation.",
          error,
        );
      }
      const verified = await readSpillInspection(input.bodyId);
      if (!verified || !sameSpillMeta(created, verified.meta)) {
        throw createContentError(
          "asset_conflict",
          "Another progressive writer won the reservation race.",
        );
      }
      return writerCapabilityFromHead(spillHead(input.bodyId, verified.meta));
    },
    async head(bodyId) {
      const current = await readSpillInspection(bodyId);
      return current ? spillHead(bodyId, current.meta) : null;
    },
    async append(input) {
      const existing = await requireSpillInspection(input.writer.bodyId);
      requireOwner(existing.meta, input.writer);
      requireOpen(existing.meta);
      if (await findIdenticalAppend(existing.meta, input)) {
        return appendResult(input, existing.meta);
      }
      if (input.expectedOffset !== existing.meta.byteLength) {
        throw createContentError(
          "asset_conflict",
          "Progressive append expected offset does not match the body.",
        );
      }
      let part: S3SpillPart | undefined;
      if (input.bytes.byteLength > 0) {
        const previousSeq = existing.meta.parts.at(-1)?.seq;
        const seq = previousSeq === undefined
          ? 0
          : advanceSpillCounter(previousSeq);
        const key = await stagingPartKey(
          input.writer.bodyId,
          existing.meta,
          seq,
          input.appendId,
        );
        await putSpillPart(key, input.bytes, input.writer.mediaType);
        part = Object.freeze({
          seq,
          appendId: input.appendId,
          offset: existing.meta.byteLength,
          length: input.bytes.byteLength,
          key,
        });
      }
      const byteLength = existing.meta.byteLength + input.bytes.byteLength;
      if (!Number.isSafeInteger(byteLength)) throw invalidSpillMeta();
      const candidate: S3SpillMeta = Object.freeze({
        ...existing.meta,
        byteLength,
        maintenanceVersion: advanceSpillCounter(
          existing.meta.maintenanceVersion,
        ),
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
        parts: part
          ? Object.freeze([...existing.meta.parts, part])
          : existing.meta.parts,
      });
      const committed = await casSpillMeta(
        input.writer.bodyId,
        existing,
        candidate,
      );
      if (committed) return appendResult(input, committed.meta);
      const raced = await readSpillInspection(input.writer.bodyId);
      if (
        raced &&
        raced.meta.reservationId === input.writer.reservationId &&
        raced.meta.writerGeneration === input.writer.generation &&
        await findIdenticalAppend(raced.meta, input)
      ) {
        return appendResult(input, raced.meta);
      }
      if (
        part &&
        !raced?.meta.parts.some((accepted) => accepted.key === part.key)
      ) {
        // The isolated create happened before the metadata CAS. A losing
        // writer owns this unreferenced key, so it can remove it without
        // touching bytes accepted by the winner.
        await deleteObject(part.key);
      }
      throw createContentError(
        "asset_conflict",
        "Progressive append lost its metadata commit race.",
      );
    },
    async readRange(input) {
      const current = await requireSpillInspection(input.bodyId);
      return await readSpillRange(current.meta, input);
    },
    async abort(input) {
      let current = await readSpillInspection(input.writer.bodyId);
      if (!current) return;
      requireOwner(current.meta, input.writer);
      if (current.meta.state === "sealing") {
        throw createContentError(
          "asset_conflict",
          "A sealing progressive body is frozen and cannot be aborted.",
        );
      }
      if (current.meta.state === "open") {
        const candidate: S3SpillMeta = Object.freeze({
          ...current.meta,
          state: "aborting",
          maintenanceVersion: advanceSpillCounter(
            current.meta.maintenanceVersion,
          ),
          leaseExpiresAt: bodyProtectionUntil(protectionMs),
        });
        const committed = await casSpillMeta(
          input.writer.bodyId,
          current,
          candidate,
        );
        if (committed) {
          current = committed;
        } else {
          const raced = await readSpillInspection(input.writer.bodyId);
          if (!raced) return;
          requireOwner(raced.meta, input.writer);
          if (raced.meta.state !== "aborting") {
            throw createContentError(
              "asset_conflict",
              "Progressive abort lost its state transition race.",
            );
          }
          current = raced;
        }
      }
      await cleanupFencedSpill(input.writer.bodyId, current);
    },
  };

  const store: BodyStore = {
    kind: "object",
    backendId,
    async put(input) {
      const protectedUntil = resolveBodyProtectionUntil(
        input.protectedUntil,
        protectionMs,
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        let response: Response;
        try {
          response = await client.makeRequest({
            method: "PUT",
            objectName: input.bodyId,
            bucketName: bucket,
            statusCode: 200,
            payload: requestPayload(input.bytes),
            returnBody: true,
            headers: new Headers({
              "content-type": input.mediaType,
              "content-length": String(input.bytes.byteLength),
              ...(provider === "gcs"
                ? { "x-goog-if-generation-match": "0" }
                : { "if-none-match": "*" }),
              [metadataHeader(provider, "sha256")]: input.digest.slice(
                "sha256:".length,
              ),
              [metadataHeader(provider, "media-type")]: input.mediaType,
              [metadataHeader(provider, "maintenance-version")]: "1",
              [metadataHeader(provider, "protected-until")]: protectedUntil,
            }),
          });
        } catch (error) {
          // Conditional PUT is the existence probe. On conflict, acquire the
          // immutable winner and renew its maintenance metadata atomically.
          const raced = await inspectReady(input.bodyId);
          if (raced) {
            const acquired = await acquireExistingReady(
              input,
              protectedUntil,
              raced,
            );
            if (acquired) return acquired;
            continue;
          }
          if (isConditionalRace(error)) continue;
          throw error;
        }
        if (!response.bodyUsed) await response.arrayBuffer();
        if (!response.ok) {
          throw createContentError(
            "asset_storage_unavailable",
            `Object upload failed with status ${response.status}.`,
          );
        }
        if (provider === "gcs") {
          const created = await inspectReady(input.bodyId);
          if (!created?.guard) {
            throw createContentError(
              "asset_storage_unavailable",
              "GCS Ready-body creation did not return a trustworthy version guard.",
            );
          }
          assertStored(input, created.head);
          return created.head;
        }

        // An S3 PUT authenticates the complete payload and metadata. S3 mode
        // remains Ready-GC-disabled, so it does not require a post-write CAS
        // identity and can avoid a redundant HEAD on the creation path.
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
      }
      throw createContentError(
        "asset_storage_unavailable",
        "Object creation remained contended.",
      );
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
    async readRange(input) {
      const ready = await inspectReady(input.bodyId);
      if (!ready) return await progressive.readRange(input);
      const start = Math.max(0, input.offset);
      const end = Math.min(input.end, ready.head.byteLength);
      if (end <= start) return new Uint8Array();
      const response = await client.getPartialObject(input.bodyId, {
        bucketName: bucket,
        offset: start,
        length: end - start,
      });
      return new Uint8Array(await response.arrayBuffer());
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
      const bodyId = input.writer.bodyId;
      for (let attempt = 0; attempt < 12; attempt++) {
        let current = await readSpillInspection(bodyId);
        if (!current) {
          const ready = await inspectReady(bodyId);
          if (
            ready && ready.head.mediaType === input.writer.mediaType &&
            (input.expectedByteLength === undefined ||
              ready.head.byteLength === input.expectedByteLength) &&
            (input.expectedDigest === undefined ||
              ready.head.digest === input.expectedDigest)
          ) {
            return ready.head;
          }
          throw createContentError(
            "asset_conflict",
            "Progressive writer no longer owns this body.",
          );
        }
        requireOwner(current.meta, input.writer);
        if (current.meta.state === "aborting") {
          throw createContentError(
            "asset_conflict",
            "An aborting progressive body cannot be sealed.",
          );
        }
        if (
          input.expectedByteLength !== undefined &&
          input.expectedByteLength !== current.meta.byteLength
        ) {
          throw createContentError(
            "asset_conflict",
            "Progressive body length does not match seal expectation.",
          );
        }
        if (current.meta.state === "open") {
          const frozen: S3SpillMeta = Object.freeze({
            ...current.meta,
            state: "sealing",
            maintenanceVersion: advanceSpillCounter(
              current.meta.maintenanceVersion,
            ),
            leaseExpiresAt: bodyProtectionUntil(protectionMs),
          });
          const committed = await casSpillMeta(bodyId, current, frozen);
          if (!committed) continue;
          current = committed;
        }

        const existingReady = await inspectReady(bodyId);
        if (current.meta.sealedDigest && existingReady) {
          if (
            existingReady.head.byteLength !== current.meta.byteLength ||
            existingReady.head.mediaType !== current.meta.mediaType ||
            existingReady.head.digest !== current.meta.sealedDigest ||
            (input.expectedDigest !== undefined &&
              input.expectedDigest !== existingReady.head.digest)
          ) {
            throw createContentError(
              "asset_conflict",
              "Ready body does not match the frozen progressive body.",
            );
          }
          await cleanupFencedSpill(bodyId, current);
          return existingReady.head;
        }

        const bytes = await readSpillRange(current.meta, {
          bodyId,
          offset: 0,
          end: current.meta.byteLength,
        });
        const digest = await digestContent(bytes);
        if (
          (input.expectedDigest && input.expectedDigest !== digest) ||
          (current.meta.sealedDigest && current.meta.sealedDigest !== digest)
        ) {
          throw createContentError(
            "asset_conflict",
            "Progressive body digest does not match seal expectation.",
          );
        }
        if (!current.meta.sealedDigest) {
          const checksummed: S3SpillMeta = Object.freeze({
            ...current.meta,
            sealedDigest: digest,
            maintenanceVersion: advanceSpillCounter(
              current.meta.maintenanceVersion,
            ),
            leaseExpiresAt: bodyProtectionUntil(protectionMs),
          });
          const committed = await casSpillMeta(bodyId, current, checksummed);
          if (!committed) continue;
          current = committed;
        }
        const ready = await store.put({
          bodyId,
          bytes,
          mediaType: current.meta.mediaType,
          digest,
        });
        // Ready publication is irreversible. Metadata remains in `sealing`
        // until all immutable staging parts have been cleaned, so a retry can
        // finish cleanup without rebuilding bytes that were already removed.
        const cleanup = await readSpillInspection(bodyId);
        if (cleanup) {
          requireOwner(cleanup.meta, input.writer);
          if (
            cleanup.meta.state !== "sealing" ||
            cleanup.meta.sealedDigest !== digest
          ) {
            throw createContentError(
              "asset_conflict",
              "Progressive seal lost its frozen cleanup ownership.",
            );
          }
          await cleanupFencedSpill(bodyId, cleanup);
        }
        return ready;
      }
      throw unavailableCoordination(
        "Progressive seal remained contended and can be retried safely.",
      );
    },
    abort: progressive.abort,
    maintenance: {
      async list(input) {
        if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
          throw new TypeError(
            "Body maintenance idle duration must be a non-negative integer.",
          );
        }
        const states = new Set(input.states);
        const bodies: (BodyHead | MutableBodyHead)[] = [];
        const listedBodyIds = new Set<string>();
        const after = input.after ?? "";
        for await (
          const entry of client.listObjects({
            bucketName: bucket,
            prefix: input.prefix ?? "",
          })
        ) {
          if (entry.key.endsWith(".progressive/meta.json")) {
            if (
              !states.has("open") && !states.has("sealing") &&
              !states.has("aborted")
            ) continue;
            const bodyId = entry.key.slice(
              0,
              -".progressive/meta.json".length,
            );
            if (bodyId <= after) continue;
            if (
              !bodyHasBeenIdle(
                entry.lastModified.toISOString(),
                input.idleForMs,
              )
            ) continue;
            const value = await progressive.head(bodyId);
            if (value && states.has(value.state)) {
              bodies.push(value);
              listedBodyIds.add(bodyId);
            }
          } else if (
            states.has("aborted") && entry.key.includes(".progressive/")
          ) {
            const marker = entry.key.indexOf(".progressive/");
            const bodyId = entry.key.slice(0, marker);
            if (
              !bodyId || bodyId <= after || listedBodyIds.has(bodyId) ||
              !bodyHasBeenIdle(
                entry.lastModified.toISOString(),
                input.idleForMs,
              )
            ) continue;
            const current = await readSpillInspection(bodyId);
            if (protectedSpillPart(bodyId, current?.meta, entry.key)) continue;
            bodies.push(Object.freeze({
              bodyId,
              state: "aborted" as const,
              mediaType: "application/octet-stream",
              byteLength: 0,
              discarded: 0,
              maintenanceVersion: 1,
              reservationId: "orphaned-progressive-parts",
            }));
            listedBodyIds.add(bodyId);
          } else if (
            states.has("ready") && !entry.key.includes(".progressive/") &&
            entry.key > after
          ) {
            if (
              !bodyHasBeenIdle(
                entry.lastModified.toISOString(),
                input.idleForMs,
              )
            ) continue;
            const value = await head(entry.key);
            if (value) bodies.push(value);
          }
          if (bodies.length >= input.limit) break;
        }
        bodies.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
        const page = bodies.slice(0, input.limit);
        return Object.freeze({
          bodies: Object.freeze(page),
          ...(page.length === input.limit
            ? { after: page[page.length - 1].bodyId }
            : {}),
        });
      },
      async delete(input) {
        if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
          throw new TypeError(
            "Body maintenance idle duration must be a non-negative integer.",
          );
        }
        if (input.expectedState === "aborted") {
          const current = await readSpillInspection(input.bodyId);
          if (
            current?.meta.state === "aborting" &&
            current.meta.maintenanceVersion ===
              input.expectedMaintenanceVersion &&
            bodyHasBeenIdle(current.lastModified, input.idleForMs)
          ) {
            await cleanupFencedSpill(input.bodyId, current);
            return true;
          }
          if (input.expectedMaintenanceVersion !== 1) return false;
          const orphans = await orphanSpillParts(
            input.bodyId,
            input.idleForMs,
          );
          await mapBounded(
            orphans,
            MAX_PARALLEL_PART_REQUESTS,
            (key) => deleteObject(key),
          );
          return orphans.length > 0;
        }
        if (input.expectedState !== "ready" || provider !== "gcs") {
          return false;
        }
        const current = await inspectReady(input.bodyId);
        if (
          !current?.guard ||
          current.head.maintenanceVersion !==
            input.expectedMaintenanceVersion ||
          bodyProtectionRemainingMs(current.head.protectedUntil) > 0 ||
          !bodyHasBeenIdle(current.head.lastModified, input.idleForMs)
        ) {
          return false;
        }
        try {
          const response = await client.makeRequest({
            method: "DELETE",
            objectName: input.bodyId,
            bucketName: bucket,
            statusCode: 204,
            returnBody: true,
            headers: new Headers({
              "x-goog-if-generation-match": current.guard.generation,
              "x-goog-if-metageneration-match": current.guard.metageneration,
            }),
          });
          if (!response.bodyUsed) await response.arrayBuffer();
          return true;
        } catch (error) {
          if (isConditionalRace(error)) return false;
          throw error;
        }
      },
    },
  };
  return Object.freeze(store);
}
