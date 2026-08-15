import { createContentError } from "./errors.ts";
import type { AssetOrigin } from "./types.ts";

export type AssetBodyStoreKind = "memory" | "filesystem" | "object";

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
  stat(path: string): Promise<AssetBodyHead | null>;
  read(path: string): Promise<Uint8Array>;
  open(path: string): Promise<ReadableStream<Uint8Array>>;
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
