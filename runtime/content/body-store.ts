import { createContentError } from "./errors.ts";
import { createMemoryOperations } from "./body-store-operations.ts";
import type { AssetOrigin } from "./types.ts";

/** Full retained-object reader used by offline owner-key and tenancy transfers. */
export type BodyReader = (
  copy: {
    key: string;
    backendId: string;
    namespace: string;
    length: number;
    kind?: string;
  },
) => Promise<{ bytes: Uint8Array; mediaType: string }>;

export type BodyStoreKind =
  | "memory"
  | "object"
  | "database";

export type BodyState =
  | "open"
  | "sealing"
  | "terminating"
  | "ready"
  | "incomplete"
  | "aborted";

type TerminalBodyHeadBase = Readonly<{
  bodyId: string;
  byteLength: number;
  mediaType: string;
  digest: `sha256:${string}`;
  maintenanceVersion: number;
  versionToken: string;
  etag?: string;
  lastModified?: string;
}>;

/** Immutable, canonical Body. Only this state may be adopted as an Asset. */
export type ReadyBodyHead = TerminalBodyHeadBase & Readonly<{ state: "ready" }>;

/**
 * Immutable committed prefix of a writer that did not complete successfully.
 * It remains readable for replay, but can never be adopted as an Asset.
 */
export type IncompleteBodyHead =
  & TerminalBodyHeadBase
  & Readonly<{ state: "incomplete" }>;

export type TerminalBodyHead = ReadyBodyHead | IncompleteBodyHead;

export type PutBodyInput = Readonly<{
  bodyId: string;
  bytes: Uint8Array;
  mediaType: string;
  digest: `sha256:${string}`;
  ifAbsent?: boolean;
}>;

/** Mutable header for a progressive body before immutable settlement. */
type MutableBodyHeadBase = Readonly<{
  bodyId: string;
  mediaType: string;
  byteLength: number;
  discarded: number;
  maintenanceVersion: number;
  versionToken: string;
  reservationId: string;
}>;

export type ActiveMutableBodyHead =
  & MutableBodyHeadBase
  & Readonly<{
    state: "open" | "sealing" | "terminating";
    writerGeneration: number;
  }>;

export type MutableBodyHead =
  | ActiveMutableBodyHead
  | (
    & MutableBodyHeadBase
    & Readonly<{
      state: "aborted";
      writerGeneration?: never;
    }>
  );

export type WriterCapability = Readonly<{
  bodyId: string;
  mediaType: string;
  reservationId: string;
  generation: number;
  byteLength: number;
  discarded: number;
}>;

export type ReserveBodyInput = Readonly<{
  bodyId: string;
  mediaType: string;
  reservationId: string;
  generation: number;
}>;

export type AppendBodyInput = Readonly<{
  writer: WriterCapability;
  expectedOffset: number;
  appendId: string;
  bytes: Uint8Array;
}>;

export type AppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
  versionToken: string;
}>;

export type ReadBodyRangeInput = Readonly<{
  bodyId: string;
  offset: number;
  end: number;
}>;

export type AbortBodyInput = Readonly<{
  writer: WriterCapability;
}>;

export type FenceBodyInput = Readonly<{
  writer: WriterCapability;
}>;

export type SealBodyInput = Readonly<{
  writer: WriterCapability;
  expectedByteLength: number;
  expectedDigest: `sha256:${string}`;
}>;

export type TerminateBodyInput = Readonly<{
  writer: WriterCapability;
  expectedByteLength: number;
  expectedDigest: `sha256:${string}`;
}>;

export type BodyMaintenanceListInput = Readonly<{
  states: readonly BodyState[];
  idleForMs: number;
  /** Optional storage-key prefix used to keep maintenance pages scope-local. */
  prefix?: string;
  after?: string;
  limit: number;
}>;

export type BodyMaintenanceDeleteInput = Readonly<{
  bodyId: string;
  expectedState: BodyState;
  expectedMaintenanceVersion?: number;
  expectedVersionToken: string;
  idleForMs: number;
}>;

export type BodyStoreMaintenance = Readonly<{
  list(
    input: BodyMaintenanceListInput,
  ): Promise<
    Readonly<
      {
        bodies: readonly (TerminalBodyHead | MutableBodyHead)[];
        after?: string;
      }
    >
  >;
  delete(input: BodyMaintenanceDeleteInput): Promise<boolean>;
}>;

export type BodyStoreDeployment = Readonly<{
  durability: "ephemeral" | "durable";
  reach: "process" | "cluster";
  /** Ready Bodies may be collected only when the backend has an exact CAS. */
  readyGarbageCollection: boolean;
}>;

export type TrustedBodyScope = Readonly<{
  namespace: string;
  databaseSchema: string;
  principal?: unknown;
}>;

export type TrustedBodyMaintenanceScope =
  & TrustedBodyScope
  & Readonly<{
    maintenance: true;
  }>;

export type BodyStoreAdapter = Readonly<{
  deployment: BodyStoreDeployment;
  forScope(scope: TrustedBodyScope): BodyStore;
  maintenanceForScope(scope: TrustedBodyMaintenanceScope): BodyStoreMaintenance;
}>;

/** Runtime-neutral body storage contract. Implementations own no graph state. */
export type BodyStore = Readonly<{
  kind: BodyStoreKind;
  backendId: string;
  /** Exact physical version deletion is supported by this backend. */
  conditionalDelete: boolean;
  put(input: PutBodyInput): Promise<ReadyBodyHead>;
  head(
    input: { bodyId: string },
  ): Promise<TerminalBodyHead | MutableBodyHead | null>;
  /**
   * Optional lookup for immutable Ready metadata only. Backends that keep
   * progressive state beside Ready bodies should skip that state here and
   * return null when no immutable Ready body exists.
   */
  headReady?(input: { bodyId: string }): Promise<ReadyBodyHead | null>;
  read(input: { bodyId: string }): Promise<ReadableStream<Uint8Array>>;
  /** Reads one finite committed byte range without waiting for future appends. */
  readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
  follow(
    input: { bodyId: string; offset?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  reserve(input: ReserveBodyInput): Promise<WriterCapability>;
  /** Exact retryable fence, including an absent-key tombstone. */
  fence(input: FenceBodyInput): Promise<WriterCapability>;
  append(input: AppendBodyInput): Promise<AppendResult>;
  seal(input: SealBodyInput): Promise<ReadyBodyHead>;
  /** Freezes the committed prefix without making it Asset-adoptable. */
  terminate(input: TerminateBodyInput): Promise<IncompleteBodyHead>;
  /** Destructively removes unpublished progressive staging. */
  abort(input: AbortBodyInput): Promise<void>;
  maintenance: BodyStoreMaintenance;
}>;

export function writerCapabilityFromHead(
  head: MutableBodyHead,
): WriterCapability {
  if (
    head.state !== "open" && head.state !== "sealing" &&
    head.state !== "terminating"
  ) {
    throw createContentError(
      "asset_conflict",
      "Only an active progressive body can produce a writer capability.",
    );
  }
  return ({
    bodyId: head.bodyId,
    mediaType: head.mediaType,
    reservationId: head.reservationId,
    generation: head.writerGeneration ?? 1,
    byteLength: head.byteLength,
    discarded: head.discarded,
  } as const);
}

export async function readBodyBytes(
  store: Pick<BodyStore, "read">,
  input: { bodyId: string },
): Promise<Uint8Array> {
  const reader = (await store.read(input)).getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    byteLength += next.value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads one finite committed Body interval.
 */
export async function readBodyRange(
  store: BodyStore,
  input: ReadBodyRangeInput,
): Promise<Uint8Array> {
  return await store.readRange(input);
}

export type BodyStorageConfig =
  | Readonly<{
    type: "database";
    config?: Readonly<{ maxBytes?: number }>;
  }>
  | Readonly<{
    type: "memory";
    config?: Readonly<{
      backendId?: string;
      prefix?: string;
    }>;
  }>
  | Readonly<{
    type: "s3";
    config: S3BodyStorageConfig;
  }>
  | Readonly<{
    type: "custom";
    config: Readonly<{
      store: BodyStore;
      prefix?: string;
      /** Omit to use the conservative, Ready-GC-disabled deployment. */
      deployment?: BodyStoreDeployment;
    }>;
  }>
  | Readonly<{
    /** Host-composed scope routing, including progressive promotion tiers. */
    type: "adapter";
    config: Readonly<{
      adapter: BodyStoreAdapter;
      prefix?: string;
    }>;
  }>;

export type BodyStorageOptions = Readonly<{
  storage?: BodyStorageConfig;
  /** Additional readers allow persisted locations from older backends to coexist. */
  readers?: readonly BodyStore[];
  readConcurrency?: number;
}>;

export type S3BodyStorageConfig = Readonly<{
  backendId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle?: boolean;
  prefix?: string;
  /**
   * Selects the object protocol used for Ready-body coordination. The default
   * `s3` mode is deliberately Ready-GC-disabled. Collection requires an exact
   * backend generation precondition, not an assumed ETag delete contract.
   * `gcs` uses the XML API's generation + metageneration preconditions and
   * therefore requires a GCS XML endpoint authenticated with HMAC keys.
   */
  provider?: "s3" | "gcs";
}>;

export type BodyStorageRuntime = Readonly<{
  adapter?: BodyStoreAdapter;
  writer?: BodyStore;
  readers: ReadonlyMap<string, BodyStore>;
  prefix: string;
  maxDatabaseBytes: number;
  readConcurrency: number;
}>;

export function createFixedBodyStoreAdapter(
  store: BodyStore,
  deployment: BodyStoreDeployment,
): BodyStoreAdapter {
  return ({
    deployment: { ...deployment } as const,
    forScope(_scope) {
      return store;
    },
    maintenanceForScope(_scope) {
      return store.maintenance;
    },
  } as const);
}

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
  const origin = input.origin ?? {
    type: "namespace",
    id: input.namespace,
  };
  return join(
    root,
    "origins",
    cleanSegment(origin.type),
    cleanSegment(origin.id),
    "assets",
    cleanSegment(input.assetId),
  );
}

/** In-process physical bytes. All lifetime and adoption decisions belong to the catalog. */
export function createMemoryBodyStore(
  options: Readonly<{ backendId?: string }> = {},
): BodyStore {
  return createMemoryOperations(options.backendId?.trim() || "memory:default");
}

export async function readBodiesBounded<T>(
  values: readonly T[],
  concurrency: number,
  read: (value: T, index: number) => Promise<Uint8Array>,
): Promise<readonly Uint8Array[]> {
  if (values.length === 0) return ([] as const);
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
  return result;
}
