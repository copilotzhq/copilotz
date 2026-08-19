import { createContentError } from "./errors.ts";
import { digestContent } from "./digest.ts";
import type { AssetOrigin } from "./types.ts";

export type AssetBodyStoreKind =
  | "memory"
  | "filesystem"
  | "object"
  | "database";

export type AssetBodyHead = Readonly<{
  key: string;
  byteLength: number;
  mediaType: string;
  digest: `sha256:${string}`;
  etag?: string;
  lastModified?: string;
}>;

export type PutAssetBodyInput = Readonly<{
  key: string;
  bytes: Uint8Array;
  mediaType: string;
  digest: `sha256:${string}`;
  ifAbsent?: boolean;
}>;

/** Durable prefix for an open progressive write. Memory stores omit this. */
export type AssetBodySpillHead = Readonly<{
  key: string;
  mediaType: string;
  byteLength: number;
  discarded: number;
  reservationId: string;
}>;

export type AssetBodySpill = Readonly<{
  reserve(
    input: Readonly<{
      key: string;
      mediaType: string;
      reservationId: string;
      takeover?: boolean;
    }>,
  ): Promise<AssetBodySpillHead>;
  head(key: string): Promise<AssetBodySpillHead | null>;
  append(
    input: Readonly<{
      key: string;
      mediaType: string;
      reservationId: string;
      bytes: Uint8Array;
    }>,
  ): Promise<AssetBodySpillHead>;
  read(
    input: Readonly<{ key: string; offset: number; end: number }>,
  ): Promise<Uint8Array>;
  truncate(
    key: string,
    byteLength: number,
    reservationId: string,
  ): Promise<AssetBodySpillHead>;
  discardPrefix(
    key: string,
    byteLength: number,
    reservationId: string,
  ): Promise<AssetBodySpillHead>;
  delete(key: string, reservationId: string): Promise<void>;
}>;

/** Runtime-neutral body storage contract. Implementations own no graph state. */
export type AssetBodyStore = Readonly<{
  kind: AssetBodyStoreKind;
  backendId: string;
  put(input: PutAssetBodyInput): Promise<AssetBodyHead>;
  head(key: string): Promise<AssetBodyHead | null>;
  read(key: string): Promise<Uint8Array>;
  open(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  list(options?: Readonly<{ prefix?: string }>): AsyncIterable<AssetBodyHead>;
  spill?: AssetBodySpill;
}>;

export type AssetStorageConfig =
  | Readonly<{
    type: "database";
    config?: Readonly<{ maxBytes?: number }>;
  }>
  | Readonly<{
    type: "memory";
    config?: Readonly<{ backendId?: string; prefix?: string }>;
  }>
  | Readonly<{
    type: "filesystem";
    config: Readonly<{
      backendId: string;
      prefix?: string;
      access: AssetFilesystemAccess;
    }>;
  }>
  | Readonly<{
    type: "s3";
    config: S3AssetStorageConfig;
  }>
  | Readonly<{
    type: "custom";
    config: Readonly<{ store: AssetBodyStore; prefix?: string }>;
  }>;

export type AssetStorageOptions = Readonly<{
  storage?: AssetStorageConfig;
  /** Additional readers allow persisted locations from older backends to coexist. */
  readers?: readonly AssetBodyStore[];
  readConcurrency?: number;
}>;

export type S3AssetStorageConfig = Readonly<{
  backendId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle?: boolean;
  prefix?: string;
}>;

/** Host callbacks used by filesystem adapters; core never imports host APIs. */
export type AssetFilesystemAccess = Readonly<{
  writeExclusive(input: PutAssetBodyInput): Promise<"created" | "exists">;
  writeReplace(
    input: Readonly<{ key: string; bytes: Uint8Array }>,
  ): Promise<void>;
  append(input: Readonly<{ key: string; bytes: Uint8Array }>): Promise<number>;
  truncate(path: string, byteLength: number): Promise<void>;
  stat(path: string): Promise<AssetBodyHead | null>;
  read(path: string): Promise<Uint8Array>;
  open(path: string): Promise<ReadableStream<Uint8Array>>;
  openFrom(path: string, offset: number): Promise<ReadableStream<Uint8Array>>;
  delete(path: string): Promise<void>;
  list(prefix: string): AsyncIterable<AssetBodyHead>;
}>;

export type AssetStorageRuntime = Readonly<{
  writer?: AssetBodyStore;
  readers: ReadonlyMap<string, AssetBodyStore>;
  prefix: string;
  maxDatabaseBytes: number;
  readConcurrency: number;
}>;

export const DEFAULT_MAX_DATABASE_ASSET_BYTES = 8 * 1024 * 1024;

function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts.flatMap((part) => part?.split("/") ?? [])
    .map((part) => part.trim()).filter(Boolean).join("/");
}

export function assetBodySchemaPrefix(
  input: Readonly<{ prefix?: string; databaseSchema: string }>,
): string {
  return join(
    input.prefix,
    "schemas",
    cleanSegment(input.databaseSchema),
  );
}

/** Deterministic provenance-bearing key. Asset identity itself stays opaque. */
export function assetBodyKey(
  input: Readonly<{
    prefix?: string;
    databaseSchema: string;
    namespace: string;
    assetId: string;
    origin?: AssetOrigin;
  }>,
): string {
  const root = join(
    assetBodySchemaPrefix(input),
    "namespaces",
    cleanSegment(input.namespace),
  );
  const origin = input.origin;
  if (!origin) return join(root, "assets", cleanSegment(input.assetId));
  const scope = origin.scope.type === "thread"
    ? ["threads", cleanSegment(origin.scope.id)]
    : origin.scope.type === "collection"
    ? [
      "collections",
      cleanSegment(origin.scope.collection),
      cleanSegment(origin.scope.id),
    ]
    : ["assets"];
  return join(
    root,
    ...scope,
    cleanSegment(origin.producer.type),
    cleanSegment(origin.producer.id),
    "assets",
    cleanSegment(input.assetId),
  );
}

function validateHead(
  expected: PutAssetBodyInput,
  actual: AssetBodyHead,
): void {
  if (
    actual.byteLength !== expected.bytes.byteLength ||
    actual.digest !== expected.digest || actual.mediaType !== expected.mediaType
  ) {
    throw createContentError(
      "asset_conflict",
      "Stored asset body conflicts with the canonical asset metadata.",
    );
  }
}

export function createMemoryAssetBodyStore(
  options: Readonly<{ backendId?: string }> = {},
): AssetBodyStore {
  const backendId = options.backendId?.trim() || "memory:default";
  const entries = new Map<string, { head: AssetBodyHead; bytes: Uint8Array }>();
  const store: AssetBodyStore = {
    kind: "memory",
    backendId,
    put(input) {
      const existing = entries.get(input.key);
      if (existing) {
        validateHead(input, existing.head);
        return Promise.resolve(existing.head);
      }
      const head = Object.freeze({
        key: input.key,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        etag: input.digest.slice("sha256:".length),
        lastModified: new Date().toISOString(),
      });
      entries.set(input.key, { head, bytes: input.bytes.slice() });
      return Promise.resolve(head);
    },
    head: (key) => Promise.resolve(entries.get(key)?.head ?? null),
    read(key) {
      const entry = entries.get(key);
      if (!entry) {
        throw createContentError(
          "asset_not_found",
          "Asset body was not found in the configured memory backend.",
        );
      }
      return Promise.resolve(entry.bytes.slice());
    },
    async open(key) {
      const bytes = await store.read(key);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    async *list(options = {}) {
      const prefix = options.prefix ?? "";
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix)) yield entry.head;
      }
    },
  };
  return Object.freeze(store);
}

function stagingDataKey(key: string): string {
  return `${key}.progressive`;
}

function stagingMetaKey(key: string): string {
  return `${key}.progressive.json`;
}

async function readStreamRange(
  stream: ReadableStream<Uint8Array>,
  length: number,
): Promise<Uint8Array> {
  if (length <= 0) {
    await stream.cancel().catch(() => undefined);
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const output = new Uint8Array(length);
  let offset = 0;
  try {
    while (offset < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, length - offset);
      output.set(value.subarray(0, take), offset);
      offset += take;
    }
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => undefined);
  }
  if (offset < length) {
    throw createContentError(
      "asset_corrupted",
      "Progressive staging ended before the requested range.",
    );
  }
  return output;
}

function parseSpillHead(
  key: string,
  bytes: Uint8Array,
): AssetBodySpillHead | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.mediaType !== "string" ||
      typeof parsed.byteLength !== "number" ||
      typeof parsed.discarded !== "number"
    ) {
      return null;
    }
    return Object.freeze({
      key,
      mediaType: parsed.mediaType,
      byteLength: parsed.byteLength,
      discarded: parsed.discarded,
      reservationId: typeof parsed.reservationId === "string"
        ? parsed.reservationId
        : "",
    });
  } catch {
    return null;
  }
}

function encodeSpillHead(head: AssetBodySpillHead): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    mediaType: head.mediaType,
    byteLength: head.byteLength,
    discarded: head.discarded,
    reservationId: head.reservationId,
  }));
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "NotFound" || /not found/i.test(error.message));
}

function createFilesystemSpill(access: AssetFilesystemAccess): AssetBodySpill {
  const readHead = async (key: string): Promise<AssetBodySpillHead | null> => {
    try {
      return parseSpillHead(key, await access.read(stagingMetaKey(key)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const writeHead = (head: AssetBodySpillHead) =>
    access.writeReplace({
      key: stagingMetaKey(head.key),
      bytes: encodeSpillHead(head),
    });
  const requireHead = async (key: string): Promise<AssetBodySpillHead> => {
    const head = await readHead(key);
    if (!head) {
      throw createContentError(
        "asset_not_found",
        "Progressive staging was not found.",
      );
    }
    return head;
  };
  const requireOwner = async (
    key: string,
    reservationId: string,
  ): Promise<AssetBodySpillHead> => {
    const head = await requireHead(key);
    if (head.reservationId !== reservationId) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this asset body.",
      );
    }
    return head;
  };
  const spill: AssetBodySpill = {
    async reserve(input) {
      const existing = await readHead(input.key);
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
        const taken = Object.freeze({
          ...existing,
          reservationId: input.reservationId,
        });
        await writeHead(taken);
        return taken;
      }
      const created = Object.freeze({
        key: input.key,
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        reservationId: input.reservationId,
      });
      const bytes = encodeSpillHead(created);
      const result = await access.writeExclusive({
        key: stagingMetaKey(input.key),
        bytes,
        mediaType: "application/json",
        digest: await digestContent(bytes),
        ifAbsent: true,
      });
      if (result === "created") return created;
      const raced = await readHead(input.key);
      if (
        input.takeover && raced && raced.mediaType === input.mediaType
      ) {
        const taken = Object.freeze({
          ...raced,
          reservationId: input.reservationId,
        });
        await writeHead(taken);
        return taken;
      }
      throw createContentError(
        "asset_conflict",
        "A progressive writer already owns this asset body.",
      );
    },
    head: readHead,
    async append(input) {
      const existing = await requireOwner(input.key, input.reservationId);
      if (existing.mediaType !== input.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      if (input.bytes.byteLength === 0) return existing;
      if (input.bytes.byteLength > 0) {
        await access.append({
          key: stagingDataKey(input.key),
          bytes: input.bytes,
        });
      }
      const head = Object.freeze({
        key: input.key,
        mediaType: input.mediaType,
        byteLength: existing.byteLength + input.bytes.byteLength,
        discarded: existing.discarded,
        reservationId: existing.reservationId,
      });
      await writeHead(head);
      return head;
    },
    async read(input) {
      const head = await requireHead(input.key);
      const start = Math.max(input.offset, head.discarded);
      const end = Math.min(input.end, head.byteLength);
      if (end <= start) return new Uint8Array();
      const stream = await access.openFrom(
        stagingDataKey(input.key),
        start - head.discarded,
      );
      return await readStreamRange(stream, end - start);
    },
    async truncate(key, byteLength, reservationId) {
      const head = await requireOwner(key, reservationId);
      if (byteLength < head.discarded || byteLength > head.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive truncate is outside the committed range.",
        );
      }
      await access.truncate(
        stagingDataKey(key),
        byteLength - head.discarded,
      );
      const next = Object.freeze({ ...head, byteLength });
      await writeHead(next);
      return next;
    },
    async discardPrefix(key, byteLength, reservationId) {
      const head = await requireOwner(key, reservationId);
      if (byteLength < head.discarded || byteLength > head.byteLength) {
        throw createContentError(
          "content_invalid",
          "Progressive discard is outside the committed range.",
        );
      }
      if (byteLength > head.discarded) {
        const kept = await spill.read({
          key,
          offset: byteLength,
          end: head.byteLength,
        });
        await access.writeReplace({
          key: stagingDataKey(key),
          bytes: kept,
        });
      }
      const next = Object.freeze({ ...head, discarded: byteLength });
      await writeHead(next);
      return next;
    },
    async delete(key, reservationId) {
      await requireOwner(key, reservationId);
      await Promise.all([
        access.delete(stagingDataKey(key)),
        access.delete(stagingMetaKey(key)),
      ]);
    },
  };
  return Object.freeze(spill);
}

export function createFilesystemAssetBodyStore(
  options: Readonly<{
    backendId: string;
    access: AssetFilesystemAccess;
  }>,
): AssetBodyStore {
  const backendId = options.backendId.trim();
  if (!backendId) {
    throw new TypeError("Filesystem backendId must be non-empty.");
  }
  const store: AssetBodyStore = {
    kind: "filesystem",
    backendId,
    async put(input) {
      await options.access.writeExclusive(input);
      const head = await options.access.stat(input.key);
      if (!head) {
        throw createContentError(
          "asset_storage_unavailable",
          "Filesystem asset write was not visible after completion.",
        );
      }
      validateHead(input, head);
      return head;
    },
    head: options.access.stat,
    read: options.access.read,
    open: options.access.open,
    delete: options.access.delete,
    list: ({ prefix = "" } = {}) => options.access.list(prefix),
    spill: createFilesystemSpill(options.access),
  };
  return Object.freeze(store);
}

export async function readAssetBodiesBounded<T>(
  values: readonly T[],
  concurrency: number,
  read: (value: T, index: number) => Promise<Uint8Array>,
): Promise<readonly Uint8Array[]> {
  if (values.length === 0) return Object.freeze([]);
  const limit = Math.max(1, Math.min(values.length, Math.floor(concurrency)));
  const result = new Array<Uint8Array>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      result[index] = await read(values[index], index);
    }
  }));
  return Object.freeze(result);
}
