import { createContentError } from "./errors.ts";
import { digestContent } from "./digest.ts";
import type { AssetOrigin } from "./types.ts";

export type BodyStoreKind =
  | "memory"
  | "filesystem"
  | "object"
  | "database";

export type BodyState =
  | "open"
  | "sealing"
  | "terminating"
  | "ready"
  | "incomplete"
  | "aborted";

export type BodyProtection = Readonly<{ remainingMs: number }>;

type TerminalBodyHeadBase = Readonly<{
  bodyId: string;
  byteLength: number;
  mediaType: string;
  digest: `sha256:${string}`;
  maintenanceVersion: number;
  protectedUntil?: string;
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

export const DEFAULT_BODY_PROTECTION_MS = 60_000;

export type PutBodyInput = Readonly<{
  bodyId: string;
  bytes: Uint8Array;
  mediaType: string;
  digest: `sha256:${string}`;
  ifAbsent?: boolean;
  protectedUntil?: string;
}>;

/** Mutable header for a progressive body before immutable settlement. */
type MutableBodyHeadBase = Readonly<{
  bodyId: string;
  mediaType: string;
  byteLength: number;
  discarded: number;
  maintenanceVersion: number;
  reservationId: string;
}>;

export type ActiveMutableBodyHead =
  & MutableBodyHeadBase
  & Readonly<{
    state: "open" | "sealing" | "terminating";
    writerGeneration: number;
    writerLeaseRemainingMs: number;
  }>;

export type MutableBodyHead =
  | ActiveMutableBodyHead
  | (
    & MutableBodyHeadBase
    & Readonly<{
      state: "aborted";
      writerGeneration?: never;
      writerLeaseRemainingMs?: never;
    }>
  );

export type WriterCapability = Readonly<{
  bodyId: string;
  mediaType: string;
  reservationId: string;
  generation: number;
  byteLength: number;
  discarded: number;
  protection: BodyProtection;
}>;

export type ReserveBodyInput = Readonly<{
  bodyId: string;
  mediaType: string;
  expectedGeneration?: number;
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
  protection: BodyProtection;
}>;

export type ReadBodyRangeInput = Readonly<{
  bodyId: string;
  offset: number;
  end: number;
}>;

export type AbortBodyInput = Readonly<{
  writer: WriterCapability;
}>;

export type RenewBodyInput = Readonly<{
  writer: WriterCapability;
}>;

export type SealBodyInput = Readonly<{
  writer: WriterCapability;
  expectedByteLength?: number;
  expectedDigest?: `sha256:${string}`;
}>;

export type TerminateBodyInput = Readonly<{
  writer: WriterCapability;
  expectedByteLength?: number;
  expectedDigest?: `sha256:${string}`;
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
  expectedMaintenanceVersion: number;
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
  minimumProtectionMs: number;
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
  put(input: PutBodyInput): Promise<ReadyBodyHead>;
  head(
    input: { bodyId: string },
  ): Promise<TerminalBodyHead | MutableBodyHead | null>;
  read(input: { bodyId: string }): Promise<ReadableStream<Uint8Array>>;
  /** Reads one finite committed byte range without waiting for future appends. */
  readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
  follow(
    input: { bodyId: string; offset?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  reserve(input: ReserveBodyInput): Promise<WriterCapability>;
  /** Renews only the currently fenced progressive writer lease. */
  renew(input: RenewBodyInput): Promise<BodyProtection>;
  append(input: AppendBodyInput): Promise<AppendResult>;
  seal(input: SealBodyInput): Promise<ReadyBodyHead>;
  /** Freezes the committed prefix without making it Asset-adoptable. */
  terminate(input: TerminateBodyInput): Promise<IncompleteBodyHead>;
  /** Destructively removes unpublished progressive staging. */
  abort(input: AbortBodyInput): Promise<void>;
  maintenance: BodyStoreMaintenance;
}>;

type ProgressiveBodyOps = Readonly<{
  reserve(input: ReserveBodyInput): Promise<WriterCapability>;
  head(bodyId: string): Promise<MutableBodyHead | null>;
  renew(input: RenewBodyInput): Promise<BodyProtection>;
  append(input: AppendBodyInput): Promise<AppendResult>;
  readRange(input: ReadBodyRangeInput): Promise<Uint8Array>;
  terminate(input: TerminateBodyInput): Promise<IncompleteBodyHead>;
  abort(input: AbortBodyInput): Promise<void>;
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
  return Object.freeze({
    bodyId: head.bodyId,
    mediaType: head.mediaType,
    reservationId: head.reservationId,
    generation: head.writerGeneration ?? 1,
    byteLength: head.byteLength,
    discarded: head.discarded,
    protection: Object.freeze({
      remainingMs: Math.max(0, head.writerLeaseRemainingMs ?? 0),
    }),
  });
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
    config?: Readonly<{ maxBytes?: number; protectionMs?: number }>;
  }>
  | Readonly<{
    type: "memory";
    config?: Readonly<{
      backendId?: string;
      prefix?: string;
      protectionMs?: number;
    }>;
  }>
  | Readonly<{
    type: "filesystem";
    config: Readonly<{
      backendId: string;
      prefix?: string;
      protectionMs?: number;
      access: BodyFilesystemAccess;
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
  protectionMs?: number;
  /**
   * Selects the object protocol used for Ready-body coordination. The default
   * `s3` mode is deliberately Ready-GC-disabled: ordinary S3 ETags identify
   * bytes, so a metadata-only protection renewal need not change the ETag.
   * `gcs` uses the XML API's generation + metageneration preconditions and
   * therefore requires a GCS XML endpoint authenticated with HMAC keys.
   */
  provider?: "s3" | "gcs";
}>;

/** Host callbacks used by filesystem adapters; core never imports host APIs. */
export type BodyFilesystemAccess = Readonly<{
  /** Linearizable create-or-renew for immutable Ready bytes and metadata. */
  acquireReady(
    input: PutBodyInput & Readonly<{ protectedUntil: string }>,
  ): Promise<ReadyBodyHead>;
  /** Atomically enforces every Ready maintenance compare-and-delete guard. */
  deleteReady(input: BodyMaintenanceDeleteInput): Promise<boolean>;
  writeExclusive(input: PutBodyInput): Promise<"created" | "exists">;
  writeReplace(
    input: Readonly<{ bodyId: string; bytes: Uint8Array }>,
  ): Promise<void>;
  append(
    input: Readonly<{ bodyId: string; bytes: Uint8Array }>,
  ): Promise<number>;
  stat(path: string): Promise<ReadyBodyHead | null>;
  /** Opens bytes only when the authoritative Ready manifest is visible. */
  openReady(path: string): Promise<ReadableStream<Uint8Array>>;
  /** Opens Ready bytes at an offset after resolving the authoritative manifest. */
  openReadyFrom(
    path: string,
    offset: number,
  ): Promise<ReadableStream<Uint8Array>>;
  read(path: string): Promise<Uint8Array>;
  open(path: string): Promise<ReadableStream<Uint8Array>>;
  openFrom(path: string, offset: number): Promise<ReadableStream<Uint8Array>>;
  delete(path: string): Promise<void>;
  list(prefix: string): AsyncIterable<ReadyBodyHead>;
  /** Enumerates only progressive metadata; it exposes no arbitrary host paths. */
  listProgressive?(): AsyncIterable<
    Readonly<{ bodyId: string; lastModified?: string }>
  >;
  /** Idempotently removes every staging artifact for one fenced Body writer. */
  cleanupProgressive?(bodyId: string): Promise<void>;
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
  return Object.freeze({
    deployment: Object.freeze({ ...deployment }),
    forScope(_scope) {
      return store;
    },
    maintenanceForScope(_scope) {
      return store.maintenance;
    },
  });
}

export const DEFAULT_MAX_DATABASE_ASSET_BYTES = 8 * 1024 * 1024;

export function bodyProtectionMs(
  value: number | undefined,
): number {
  const resolved = value ?? DEFAULT_BODY_PROTECTION_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(
      "Body protection duration must be a non-negative integer.",
    );
  }
  return resolved;
}

export function bodyProtectionUntil(
  protectionMs: number,
  now: number = Date.now(),
): string {
  return new Date(now + protectionMs).toISOString();
}

export function bodyProtectionRemainingMs(
  protectedUntil: string | undefined,
  now: number = Date.now(),
): number {
  if (!protectedUntil) return 0;
  const expiresAt = Date.parse(protectedUntil);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - now);
}

export function resolveBodyProtectionUntil(
  requested: string | undefined,
  protectionMs: number,
  now: number = Date.now(),
): string {
  const value = requested ?? bodyProtectionUntil(protectionMs, now);
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) {
    throw new TypeError("Body protection deadline must be a valid timestamp.");
  }
  return new Date(expiresAt).toISOString();
}

export function latestBodyProtectionUntil(
  current: string | undefined,
  requested: string,
): string {
  const currentAt = current ? Date.parse(current) : Number.NEGATIVE_INFINITY;
  const requestedAt = Date.parse(requested);
  if (
    (current !== undefined && !Number.isFinite(currentAt)) ||
    !Number.isFinite(requestedAt)
  ) {
    throw new TypeError("Body protection deadline must be a valid timestamp.");
  }
  return new Date(Math.max(currentAt, requestedAt)).toISOString();
}

export function bodyHasBeenIdle(
  lastModified: string | undefined,
  idleForMs: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isSafeInteger(idleForMs) || idleForMs < 0) {
    throw new TypeError(
      "Body maintenance idle duration must be a non-negative integer.",
    );
  }
  if (idleForMs === 0) return true;
  if (!lastModified) return false;
  const modifiedAt = Date.parse(lastModified);
  return Number.isFinite(modifiedAt) && modifiedAt <= now - idleForMs;
}

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

function validateHead(
  expected: PutBodyInput,
  actual: ReadyBodyHead,
): void {
  if (
    actual.bodyId !== expected.bodyId ||
    actual.byteLength !== expected.bytes.byteLength ||
    actual.digest !== expected.digest || actual.mediaType !== expected.mediaType
  ) {
    throw createContentError(
      "asset_conflict",
      "Stored asset body conflicts with the canonical asset metadata.",
    );
  }
}

function sliceChunks(
  chunks: readonly Uint8Array[],
  start: number,
  end: number,
): Uint8Array {
  const length = Math.max(0, end - start);
  const output = new Uint8Array(length);
  let cursor = 0;
  let skipped = 0;
  for (const chunk of chunks) {
    const next = skipped + chunk.byteLength;
    if (next <= start) {
      skipped = next;
      continue;
    }
    const from = Math.max(0, start - skipped);
    const to = Math.min(chunk.byteLength, end - skipped);
    output.set(chunk.subarray(from, to), cursor);
    cursor += to - from;
    skipped = next;
    if (skipped >= end) break;
  }
  return output;
}

export function createMemoryBodyStore(
  options: Readonly<{ backendId?: string; protectionMs?: number }> = {},
): BodyStore {
  const backendId = options.backendId?.trim() || "memory:default";
  const protectionMs = bodyProtectionMs(options.protectionMs);
  const entries = new Map<
    string,
    { head: TerminalBodyHead; bytes: Uint8Array; updatedAt: number }
  >();
  const mutable = new Map<
    string,
    {
      head: ActiveMutableBodyHead;
      leaseExpiresAt: number;
      updatedAt: number;
      chunks: Uint8Array[];
      appendIds: Map<string, Uint8Array>;
    }
  >();
  const withLease = (
    head: ActiveMutableBodyHead,
    leaseExpiresAt: number,
  ): ActiveMutableBodyHead =>
    Object.freeze({
      ...head,
      writerLeaseRemainingMs: Math.max(0, leaseExpiresAt - Date.now()),
    });
  const newLeaseExpiresAt = () => Date.now() + protectionMs;
  const store: BodyStore = {
    kind: "memory",
    backendId,
    put(input) {
      if (mutable.has(input.bodyId)) {
        throw createContentError(
          "asset_conflict",
          "A progressive body already exists for this id.",
        );
      }
      const now = Date.now();
      const requestedProtection = resolveBodyProtectionUntil(
        input.protectedUntil,
        protectionMs,
        now,
      );
      const existing = entries.get(input.bodyId);
      if (existing) {
        if (existing.head.state !== "ready") {
          throw createContentError(
            "asset_conflict",
            "An incomplete body already exists for this id.",
          );
        }
        validateHead(input, existing.head);
        const head = Object.freeze({
          ...existing.head,
          maintenanceVersion: existing.head.maintenanceVersion + 1,
          protectedUntil: latestBodyProtectionUntil(
            existing.head.protectedUntil,
            requestedProtection,
          ),
          lastModified: new Date(now).toISOString(),
        });
        entries.set(input.bodyId, {
          head,
          bytes: existing.bytes,
          updatedAt: now,
        });
        return Promise.resolve(head);
      }
      const head = Object.freeze({
        bodyId: input.bodyId,
        state: "ready" as const,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        maintenanceVersion: 1,
        protectedUntil: requestedProtection,
        etag: input.digest.slice("sha256:".length),
        lastModified: new Date(now).toISOString(),
      });
      entries.set(input.bodyId, {
        head,
        bytes: input.bytes.slice(),
        updatedAt: now,
      });
      return Promise.resolve(head);
    },
    head: ({ bodyId }) =>
      Promise.resolve(
        entries.get(bodyId)?.head ??
          (() => {
            const current = mutable.get(bodyId);
            return current
              ? withLease(current.head, current.leaseExpiresAt)
              : null;
          })(),
      ),
    read({ bodyId }) {
      const entry = entries.get(bodyId);
      if (!entry) {
        throw createContentError(
          "asset_not_found",
          "Asset body was not found in the configured memory backend.",
        );
      }
      const bytes = entry.bytes.slice();
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    },
    readRange(input) {
      const start = Math.max(0, input.offset);
      const ready = entries.get(input.bodyId);
      if (ready) {
        const end = Math.min(input.end, ready.bytes.byteLength);
        return Promise.resolve(
          end <= start ? new Uint8Array() : ready.bytes.slice(start, end),
        );
      }
      const current = mutable.get(input.bodyId);
      if (!current) {
        throw createContentError(
          "asset_not_found",
          "Asset body was not found in the configured memory backend.",
        );
      }
      const rangedStart = Math.max(start, current.head.discarded);
      const end = Math.min(input.end, current.head.byteLength);
      return Promise.resolve(
        end <= rangedStart ? new Uint8Array() : sliceChunks(
          current.chunks,
          rangedStart - current.head.discarded,
          end - current.head.discarded,
        ),
      );
    },
    follow(input) {
      const offset = Math.max(0, input.offset ?? 0);
      const ready = entries.get(input.bodyId);
      const bytes = ready ? ready.bytes.slice() : (() => {
        const current = mutable.get(input.bodyId);
        if (!current) {
          throw createContentError(
            "asset_not_found",
            "Asset body was not found in the configured memory backend.",
          );
        }
        return sliceChunks(
          current.chunks,
          Math.max(offset, current.head.discarded) -
            current.head.discarded,
          current.head.byteLength,
        );
      })();
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue(ready ? bytes.subarray(offset) : bytes);
            controller.close();
          },
        }),
      );
    },
    reserve(input) {
      const existing = mutable.get(input.bodyId);
      if (existing) {
        if (existing.head.mediaType !== input.mediaType) {
          throw createContentError(
            "asset_conflict",
            "Progressive body media type does not match the writer.",
          );
        }
        if (
          input.expectedGeneration === undefined ||
          input.expectedGeneration !== (existing.head.writerGeneration ?? 1)
        ) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer already owns this body.",
          );
        }
        if (existing.leaseExpiresAt > Date.now()) {
          throw createContentError(
            "asset_conflict",
            "A progressive writer lease is still live for this body.",
          );
        }
        const leaseExpiresAt = newLeaseExpiresAt();
        const head = Object.freeze({
          ...existing.head,
          reservationId: crypto.randomUUID(),
          maintenanceVersion: existing.head.maintenanceVersion + 1,
          writerGeneration: (existing.head.writerGeneration ?? 1) + 1,
          writerLeaseRemainingMs: protectionMs,
        });
        mutable.set(input.bodyId, {
          ...existing,
          head,
          leaseExpiresAt,
          updatedAt: Date.now(),
        });
        return Promise.resolve(writerCapabilityFromHead(head));
      }
      if (entries.has(input.bodyId)) {
        throw createContentError(
          "asset_conflict",
          "An immutable body already exists for this id.",
        );
      }
      const head = Object.freeze({
        bodyId: input.bodyId,
        state: "open" as const,
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        maintenanceVersion: 1,
        writerGeneration: 1,
        writerLeaseRemainingMs: protectionMs,
        reservationId: crypto.randomUUID(),
      });
      mutable.set(input.bodyId, {
        head,
        leaseExpiresAt: newLeaseExpiresAt(),
        updatedAt: Date.now(),
        chunks: [],
        appendIds: new Map(),
      });
      return Promise.resolve(writerCapabilityFromHead(head));
    },
    renew(input) {
      const entry = mutable.get(input.writer.bodyId);
      if (
        !entry || entry.head.reservationId !== input.writer.reservationId ||
        entry.head.state !== "open"
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      const leaseExpiresAt = newLeaseExpiresAt();
      const head = Object.freeze({
        ...entry.head,
        maintenanceVersion: entry.head.maintenanceVersion + 1,
        writerLeaseRemainingMs: protectionMs,
      });
      mutable.set(input.writer.bodyId, {
        ...entry,
        head,
        leaseExpiresAt,
        updatedAt: Date.now(),
      });
      return Promise.resolve(Object.freeze({
        remainingMs: Math.max(0, leaseExpiresAt - Date.now()),
      }));
    },
    append(input) {
      const entry = mutable.get(input.writer.bodyId);
      if (!entry || entry.head.reservationId !== input.writer.reservationId) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      if (entry.head.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      if (entry.head.mediaType !== input.writer.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive body media type does not match the writer.",
        );
      }
      const duplicate = entry.appendIds.get(input.appendId);
      if (duplicate) {
        const same = duplicate.byteLength === input.bytes.byteLength &&
          duplicate.every((byte, index) => byte === input.bytes[index]);
        if (!same) {
          throw createContentError(
            "asset_conflict",
            "Progressive append id was reused with different bytes.",
          );
        }
        return Promise.resolve(Object.freeze({
          startOffset: input.expectedOffset,
          endOffset: entry.head.byteLength,
          protection: Object.freeze({
            remainingMs: Math.max(0, entry.leaseExpiresAt - Date.now()),
          }),
        }));
      }
      if (input.expectedOffset !== entry.head.byteLength) {
        throw createContentError(
          "asset_conflict",
          "Progressive append expected offset does not match the body.",
        );
      }
      const leaseExpiresAt = newLeaseExpiresAt();
      const head = Object.freeze({
        ...entry.head,
        byteLength: entry.head.byteLength + input.bytes.byteLength,
        maintenanceVersion: entry.head.maintenanceVersion + 1,
        writerLeaseRemainingMs: protectionMs,
      });
      const bytes = input.bytes.slice();
      entry.chunks.push(bytes);
      entry.appendIds.set(input.appendId, bytes);
      mutable.set(input.writer.bodyId, {
        head,
        leaseExpiresAt,
        updatedAt: Date.now(),
        chunks: entry.chunks,
        appendIds: entry.appendIds,
      });
      return Promise.resolve(Object.freeze({
        startOffset: input.expectedOffset,
        endOffset: head.byteLength,
        protection: Object.freeze({
          remainingMs: Math.max(0, head.writerLeaseRemainingMs ?? 0),
        }),
      }));
    },
    async seal(input) {
      let entry = mutable.get(input.writer.bodyId);
      if (!entry || entry.head.reservationId !== input.writer.reservationId) {
        const terminal = entries.get(input.writer.bodyId)?.head;
        if (
          terminal?.state === "ready" &&
          (input.expectedByteLength === undefined ||
            input.expectedByteLength === terminal.byteLength) &&
          (input.expectedDigest === undefined ||
            input.expectedDigest === terminal.digest)
        ) {
          return terminal;
        }
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      if (entry.head.state !== "open" && entry.head.state !== "sealing") {
        throw createContentError(
          "asset_conflict",
          "Progressive body cannot be sealed from its current state.",
        );
      }
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== entry.head.byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match seal expectation.",
        );
      }
      if (entry.head.state === "open") {
        const head: ActiveMutableBodyHead = Object.freeze({
          ...entry.head,
          state: "sealing",
          maintenanceVersion: entry.head.maintenanceVersion + 1,
        });
        entry = { ...entry, head, updatedAt: Date.now() };
        // Freeze the committed prefix before the digest yields. Append and
        // terminate synchronously observe `sealing` from this point onward.
        mutable.set(input.writer.bodyId, entry);
      }
      const settlingVersion = entry.head.maintenanceVersion;
      const bytes = sliceChunks(entry.chunks, 0, entry.head.byteLength);
      const digest = await digestContent(bytes);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw createContentError(
          "asset_conflict",
          "Progressive body digest does not match seal expectation.",
        );
      }
      const current = mutable.get(input.writer.bodyId);
      if (
        !current || current.head.state !== "sealing" ||
        current.head.reservationId !== input.writer.reservationId ||
        current.head.maintenanceVersion !== settlingVersion
      ) {
        const terminal = entries.get(input.writer.bodyId)?.head;
        if (
          terminal?.state === "ready" &&
          terminal.byteLength === bytes.byteLength &&
          terminal.digest === digest
        ) {
          return terminal;
        }
        throw createContentError(
          "asset_conflict",
          "Progressive writer was fenced while sealing this body.",
        );
      }
      const head = Object.freeze({
        bodyId: input.writer.bodyId,
        state: "ready" as const,
        byteLength: bytes.byteLength,
        mediaType: current.head.mediaType,
        digest,
        maintenanceVersion: current.head.maintenanceVersion + 1,
        protectedUntil: bodyProtectionUntil(protectionMs),
        etag: digest.slice("sha256:".length),
        lastModified: new Date().toISOString(),
      });
      entries.set(input.writer.bodyId, {
        head,
        bytes,
        updatedAt: Date.now(),
      });
      mutable.delete(input.writer.bodyId);
      return head;
    },
    async terminate(input) {
      let entry = mutable.get(input.writer.bodyId);
      if (!entry || entry.head.reservationId !== input.writer.reservationId) {
        const terminal = entries.get(input.writer.bodyId)?.head;
        if (terminal?.state === "incomplete") {
          if (
            (input.expectedByteLength !== undefined &&
              input.expectedByteLength !== terminal.byteLength) ||
            (input.expectedDigest !== undefined &&
              input.expectedDigest !== terminal.digest)
          ) {
            throw createContentError(
              "asset_conflict",
              "Incomplete body conflicts with terminate expectations.",
            );
          }
          return terminal;
        }
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      if (
        entry.head.state !== "open" && entry.head.state !== "terminating"
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body cannot be terminated from its current state.",
        );
      }
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== entry.head.byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match terminate expectation.",
        );
      }
      if (entry.head.state === "open") {
        const head: ActiveMutableBodyHead = Object.freeze({
          ...entry.head,
          state: "terminating",
          maintenanceVersion: entry.head.maintenanceVersion + 1,
        });
        entry = { ...entry, head, updatedAt: Date.now() };
        // The terminal prefix becomes immutable before digesting it.
        mutable.set(input.writer.bodyId, entry);
      }
      const settlingVersion = entry.head.maintenanceVersion;
      const bytes = sliceChunks(entry.chunks, 0, entry.head.byteLength);
      const digest = await digestContent(bytes);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw createContentError(
          "asset_conflict",
          "Progressive body digest does not match terminate expectation.",
        );
      }
      const current = mutable.get(input.writer.bodyId);
      if (
        !current || current.head.state !== "terminating" ||
        current.head.reservationId !== input.writer.reservationId ||
        current.head.maintenanceVersion !== settlingVersion
      ) {
        const terminal = entries.get(input.writer.bodyId)?.head;
        if (
          terminal?.state === "incomplete" &&
          terminal.byteLength === bytes.byteLength && terminal.digest === digest
        ) {
          return terminal;
        }
        throw createContentError(
          "asset_conflict",
          "Progressive writer was fenced while terminating this body.",
        );
      }
      const now = Date.now();
      const head: IncompleteBodyHead = Object.freeze({
        bodyId: input.writer.bodyId,
        state: "incomplete",
        byteLength: bytes.byteLength,
        mediaType: current.head.mediaType,
        digest,
        maintenanceVersion: current.head.maintenanceVersion + 1,
        protectedUntil: bodyProtectionUntil(protectionMs, now),
        etag: digest.slice("sha256:".length),
        lastModified: new Date(now).toISOString(),
      });
      entries.set(input.writer.bodyId, { head, bytes, updatedAt: now });
      mutable.delete(input.writer.bodyId);
      return head;
    },
    abort(input) {
      const entry = mutable.get(input.writer.bodyId);
      if (entry && entry.head.reservationId !== input.writer.reservationId) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns this body.",
        );
      }
      if (entry && entry.head.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Only open unpublished staging can be aborted.",
        );
      }
      mutable.delete(input.writer.bodyId);
      return Promise.resolve();
    },
    maintenance: {
      list(input) {
        const states = new Set<BodyState>(input.states);
        const bodies: (TerminalBodyHead | MutableBodyHead)[] = [];
        for (const entry of entries.values()) {
          if (
            entry.head.bodyId.startsWith(input.prefix ?? "") &&
            states.has(entry.head.state) &&
            bodyHasBeenIdle(
              entry.head.lastModified,
              input.idleForMs,
            )
          ) {
            bodies.push(entry.head);
          }
        }
        for (const entry of mutable.values()) {
          if (
            entry.head.bodyId.startsWith(input.prefix ?? "") &&
            states.has(entry.head.state) &&
            bodyHasBeenIdle(
              new Date(entry.updatedAt).toISOString(),
              input.idleForMs,
            )
          ) {
            bodies.push(withLease(entry.head, entry.leaseExpiresAt));
          }
        }
        bodies.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
        const after = input.after ?? "";
        const page = bodies.filter((body) => body.bodyId > after).slice(
          0,
          input.limit,
        );
        return Promise.resolve(Object.freeze({
          bodies: Object.freeze(page),
          ...(page.length === input.limit
            ? { after: page[page.length - 1].bodyId }
            : {}),
        }));
      },
      delete(input) {
        const ready = entries.get(input.bodyId);
        if (
          ready &&
          ready.head.state === input.expectedState &&
          ready.head.maintenanceVersion === input.expectedMaintenanceVersion &&
          bodyProtectionRemainingMs(ready.head.protectedUntil) === 0 &&
          bodyHasBeenIdle(
            ready.head.lastModified,
            input.idleForMs,
          )
        ) {
          entries.delete(input.bodyId);
          return Promise.resolve(true);
        }
        const current = mutable.get(input.bodyId);
        if (
          current &&
          current.head.state === input.expectedState &&
          current.head.maintenanceVersion ===
            input.expectedMaintenanceVersion &&
          current.leaseExpiresAt <= Date.now() &&
          bodyHasBeenIdle(
            new Date(current.updatedAt).toISOString(),
            input.idleForMs,
          )
        ) {
          mutable.delete(input.bodyId);
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      },
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

type FilesystemSpillHead =
  | (ActiveMutableBodyHead & Readonly<{ leaseExpiresAt?: string }>)
  | IncompleteBodyHead;

type FilesystemProgressiveOps =
  & ProgressiveBodyOps
  & Readonly<{
    headAny(bodyId: string): Promise<FilesystemSpillHead | null>;
    beginSeal(input: SealBodyInput): Promise<ActiveMutableBodyHead>;
    cleanupAfterSeal(input: AbortBodyInput): Promise<void>;
  }>;

function parseSpillHead(
  bodyId: string,
  bytes: Uint8Array,
): FilesystemSpillHead | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.mediaType !== "string" ||
      typeof parsed.byteLength !== "number" ||
      typeof parsed.discarded !== "number" ||
      (parsed.state !== "open" && parsed.state !== "sealing" &&
        parsed.state !== "terminating" && parsed.state !== "incomplete")
    ) {
      return null;
    }
    const state = parsed.state === "incomplete"
      ? "incomplete"
      : parsed.state === "sealing"
      ? "sealing"
      : parsed.state === "terminating"
      ? "terminating"
      : "open";
    const leaseExpiresAt = typeof parsed.leaseExpiresAt === "string"
      ? parsed.leaseExpiresAt
      : undefined;
    if (state === "incomplete") {
      if (typeof parsed.digest !== "string") return null;
      return Object.freeze({
        bodyId,
        state,
        mediaType: parsed.mediaType,
        byteLength: parsed.byteLength,
        digest: parsed.digest as `sha256:${string}`,
        maintenanceVersion: typeof parsed.maintenanceVersion === "number"
          ? parsed.maintenanceVersion
          : 1,
        ...(typeof parsed.protectedUntil === "string"
          ? { protectedUntil: parsed.protectedUntil }
          : {}),
        etag: parsed.digest.slice("sha256:".length),
        ...(typeof parsed.lastModified === "string"
          ? { lastModified: parsed.lastModified }
          : {}),
      });
    }
    return Object.freeze({
      bodyId,
      state,
      mediaType: parsed.mediaType,
      byteLength: parsed.byteLength,
      discarded: parsed.discarded,
      maintenanceVersion: typeof parsed.maintenanceVersion === "number"
        ? parsed.maintenanceVersion
        : 1,
      writerGeneration: typeof parsed.writerGeneration === "number"
        ? parsed.writerGeneration
        : 1,
      writerLeaseRemainingMs: bodyProtectionRemainingMs(leaseExpiresAt),
      reservationId: typeof parsed.reservationId === "string"
        ? parsed.reservationId
        : "",
      ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    });
  } catch {
    return null;
  }
}

function encodeSpillHead(
  head: FilesystemSpillHead,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    state: head.state,
    mediaType: head.mediaType,
    byteLength: head.byteLength,
    discarded: head.state === "incomplete" ? 0 : head.discarded,
    maintenanceVersion: head.maintenanceVersion,
    writerGeneration: head.state === "incomplete"
      ? undefined
      : head.writerGeneration,
    reservationId: head.state === "incomplete" ? undefined : head.reservationId,
    leaseExpiresAt: head.state === "incomplete"
      ? undefined
      : head.leaseExpiresAt,
    digest: head.state === "incomplete" ? head.digest : undefined,
    protectedUntil: head.state === "incomplete"
      ? head.protectedUntil
      : undefined,
    lastModified: head.state === "incomplete" ? head.lastModified : undefined,
  }));
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "NotFound" || /not found/i.test(error.message));
}

function createFilesystemProgressive(
  access: BodyFilesystemAccess,
  protectionMs: number,
): FilesystemProgressiveOps {
  type SpillHead =
    & ActiveMutableBodyHead
    & Readonly<{ leaseExpiresAt?: string }>;
  const readHeadAny = async (
    bodyId: string,
  ): Promise<FilesystemSpillHead | null> => {
    try {
      return parseSpillHead(bodyId, await access.read(stagingMetaKey(bodyId)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const readHead = async (bodyId: string): Promise<SpillHead | null> => {
    const head = await readHeadAny(bodyId);
    return head?.state === "open" || head?.state === "sealing" ||
        head?.state === "terminating"
      ? head
      : null;
  };
  const writeHead = (head: SpillHead) =>
    access.writeReplace({
      bodyId: stagingMetaKey(head.bodyId),
      bytes: encodeSpillHead(head),
    });
  const requireHead = async (bodyId: string): Promise<SpillHead> => {
    const head = await readHead(bodyId);
    if (!head) {
      throw createContentError(
        "asset_not_found",
        "Progressive staging was not found.",
      );
    }
    return head;
  };
  const requireOwner = async (
    bodyId: string,
    reservationId: string,
  ): Promise<SpillHead> => {
    const head = await requireHead(bodyId);
    if (head.reservationId !== reservationId) {
      throw createContentError(
        "asset_conflict",
        "Progressive writer no longer owns this asset body.",
      );
    }
    return head;
  };
  const cleanup = async (bodyId: string): Promise<void> => {
    if (access.cleanupProgressive) {
      await access.cleanupProgressive(bodyId);
      return;
    }
    // Metadata is the visibility authority. Keeping it until the data delete
    // succeeds makes an interrupted cleanup discoverable and retry-safe.
    await access.delete(stagingDataKey(bodyId));
    await access.delete(stagingMetaKey(bodyId));
  };
  const progressive: FilesystemProgressiveOps = {
    headAny: readHeadAny,
    async reserve(input) {
      const immutable = await readHeadAny(input.bodyId);
      if (immutable?.state === "incomplete") {
        throw createContentError(
          "asset_conflict",
          "An incomplete body already exists for this id.",
        );
      }
      const existing = immutable;
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
        const taken = Object.freeze({
          ...existing,
          reservationId: crypto.randomUUID(),
          maintenanceVersion: existing.maintenanceVersion + 1,
          writerGeneration: existing.writerGeneration + 1,
          writerLeaseRemainingMs: protectionMs,
          leaseExpiresAt: bodyProtectionUntil(protectionMs),
        });
        await writeHead(taken);
        return writerCapabilityFromHead(taken);
      }
      const created = Object.freeze({
        bodyId: input.bodyId,
        state: "open" as const,
        mediaType: input.mediaType,
        byteLength: 0,
        discarded: 0,
        maintenanceVersion: 1,
        writerGeneration: 1,
        writerLeaseRemainingMs: protectionMs,
        reservationId: crypto.randomUUID(),
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
      });
      const bytes = encodeSpillHead(created);
      const result = await access.writeExclusive({
        bodyId: stagingMetaKey(input.bodyId),
        bytes,
        mediaType: "application/json",
        digest: await digestContent(bytes),
        ifAbsent: true,
      });
      if (result === "created") return writerCapabilityFromHead(created);
      const raced = await readHead(input.bodyId);
      if (
        input.expectedGeneration !== undefined && raced &&
        raced.mediaType === input.mediaType &&
        input.expectedGeneration === raced.writerGeneration &&
        bodyProtectionRemainingMs(raced.leaseExpiresAt) === 0
      ) {
        const taken = Object.freeze({
          ...raced,
          reservationId: crypto.randomUUID(),
          maintenanceVersion: raced.maintenanceVersion + 1,
          writerGeneration: raced.writerGeneration + 1,
          writerLeaseRemainingMs: protectionMs,
          leaseExpiresAt: bodyProtectionUntil(protectionMs),
        });
        await writeHead(taken);
        return writerCapabilityFromHead(taken);
      }
      throw createContentError(
        "asset_conflict",
        "A progressive writer already owns this asset body.",
      );
    },
    head: readHead,
    async beginSeal(input) {
      const existing = await requireOwner(
        input.writer.bodyId,
        input.writer.reservationId,
      );
      if (existing.state !== "open" && existing.state !== "sealing") {
        throw createContentError(
          "asset_conflict",
          "Progressive body cannot be sealed from its current state.",
        );
      }
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== existing.byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match seal expectation.",
        );
      }
      if (existing.state === "sealing") return existing;
      const sealing: SpillHead = Object.freeze({
        ...existing,
        state: "sealing" as const,
        maintenanceVersion: existing.maintenanceVersion + 1,
      });
      await writeHead(sealing);
      return sealing;
    },
    async cleanupAfterSeal(input) {
      const existing = await readHead(input.writer.bodyId);
      if (!existing) return;
      if (
        existing.reservationId !== input.writer.reservationId ||
        existing.state !== "sealing"
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive writer no longer owns sealed staging.",
        );
      }
      await cleanup(input.writer.bodyId);
    },
    async renew(input) {
      const existing = await requireOwner(
        input.writer.bodyId,
        input.writer.reservationId,
      );
      if (existing.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      const head = Object.freeze({
        ...existing,
        maintenanceVersion: existing.maintenanceVersion + 1,
        writerLeaseRemainingMs: protectionMs,
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
      });
      await writeHead(head);
      return Object.freeze({
        remainingMs: bodyProtectionRemainingMs(head.leaseExpiresAt),
      });
    },
    async append(input) {
      const existing = await requireOwner(
        input.writer.bodyId,
        input.writer.reservationId,
      );
      if (existing.mediaType !== input.writer.mediaType) {
        throw createContentError(
          "asset_conflict",
          "Progressive staging media type does not match the writer.",
        );
      }
      if (existing.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Progressive body is not open.",
        );
      }
      if (input.bytes.byteLength === 0) {
        return Object.freeze({
          startOffset: input.expectedOffset,
          endOffset: existing.byteLength,
          protection: Object.freeze({
            remainingMs: bodyProtectionRemainingMs(existing.leaseExpiresAt),
          }),
        });
      }
      if (input.expectedOffset < existing.byteLength) {
        const existingBytes = await progressive.readRange({
          bodyId: input.writer.bodyId,
          offset: input.expectedOffset,
          end: input.expectedOffset + input.bytes.byteLength,
        });
        const same = existingBytes.byteLength === input.bytes.byteLength &&
          existingBytes.every((byte, index) => byte === input.bytes[index]);
        if (same) {
          return Object.freeze({
            startOffset: input.expectedOffset,
            endOffset: existing.byteLength,
            protection: Object.freeze({
              remainingMs: Math.max(0, existing.writerLeaseRemainingMs ?? 0),
            }),
          });
        }
        throw createContentError(
          "asset_conflict",
          "Progressive append id was reused with different bytes.",
        );
      }
      if (input.expectedOffset !== existing.byteLength) {
        throw createContentError(
          "asset_conflict",
          "Progressive append expected offset does not match the body.",
        );
      }
      if (input.bytes.byteLength > 0) {
        await access.append({
          bodyId: stagingDataKey(input.writer.bodyId),
          bytes: input.bytes,
        });
      }
      const head = Object.freeze({
        bodyId: input.writer.bodyId,
        state: "open" as const,
        mediaType: input.writer.mediaType,
        byteLength: existing.byteLength + input.bytes.byteLength,
        discarded: existing.discarded,
        maintenanceVersion: existing.maintenanceVersion + 1,
        writerGeneration: existing.writerGeneration,
        writerLeaseRemainingMs: protectionMs,
        reservationId: existing.reservationId,
        leaseExpiresAt: bodyProtectionUntil(protectionMs),
      });
      await writeHead(head);
      return Object.freeze({
        startOffset: input.expectedOffset,
        endOffset: head.byteLength,
        protection: Object.freeze({
          remainingMs: Math.max(0, head.writerLeaseRemainingMs ?? 0),
        }),
      });
    },
    async readRange(input) {
      const head = await readHeadAny(input.bodyId);
      if (!head) {
        throw createContentError(
          "asset_not_found",
          "Progressive staging was not found.",
        );
      }
      const discarded = head.state === "incomplete" ? 0 : head.discarded;
      const start = Math.max(input.offset, discarded);
      const end = Math.min(input.end, head.byteLength);
      if (end <= start) return new Uint8Array();
      const stream = await access.openFrom(
        stagingDataKey(input.bodyId),
        start - discarded,
      );
      return await readStreamRange(stream, end - start);
    },
    async terminate(input) {
      const terminal = await readHeadAny(input.writer.bodyId);
      if (terminal?.state === "incomplete") {
        if (
          (input.expectedByteLength !== undefined &&
            input.expectedByteLength !== terminal.byteLength) ||
          (input.expectedDigest !== undefined &&
            input.expectedDigest !== terminal.digest)
        ) {
          throw createContentError(
            "asset_conflict",
            "Incomplete body conflicts with terminate expectations.",
          );
        }
        return terminal;
      }
      const existing = await requireOwner(
        input.writer.bodyId,
        input.writer.reservationId,
      );
      if (existing.state !== "open" && existing.state !== "terminating") {
        throw createContentError(
          "asset_conflict",
          "Progressive body cannot be terminated from its current state.",
        );
      }
      if (
        input.expectedByteLength !== undefined &&
        input.expectedByteLength !== existing.byteLength
      ) {
        throw createContentError(
          "asset_conflict",
          "Progressive body length does not match terminate expectation.",
        );
      }
      const terminating: SpillHead = existing.state === "terminating"
        ? existing
        : Object.freeze({
          ...existing,
          state: "terminating" as const,
          maintenanceVersion: existing.maintenanceVersion + 1,
        });
      if (existing.state !== "terminating") await writeHead(terminating);
      const bytes = await progressive.readRange({
        bodyId: input.writer.bodyId,
        offset: 0,
        end: terminating.byteLength,
      });
      const digest = await digestContent(bytes);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw createContentError(
          "asset_conflict",
          "Progressive body digest does not match terminate expectation.",
        );
      }
      const now = Date.now();
      const incomplete: IncompleteBodyHead = Object.freeze({
        bodyId: input.writer.bodyId,
        state: "incomplete",
        mediaType: terminating.mediaType,
        byteLength: terminating.byteLength,
        digest,
        maintenanceVersion: terminating.maintenanceVersion + 1,
        protectedUntil: bodyProtectionUntil(protectionMs, now),
        etag: digest.slice("sha256:".length),
        lastModified: new Date(now).toISOString(),
      });
      await access.writeReplace({
        bodyId: stagingMetaKey(input.writer.bodyId),
        bytes: encodeSpillHead(incomplete),
      });
      return incomplete;
    },
    async abort(input) {
      const existing = await requireOwner(
        input.writer.bodyId,
        input.writer.reservationId,
      );
      if (existing.state !== "open") {
        throw createContentError(
          "asset_conflict",
          "Only open unpublished staging can be aborted.",
        );
      }
      await cleanup(input.writer.bodyId);
    },
  };
  return Object.freeze(progressive);
}

// Filesystem adapters advertise process reach. Serialize every mutation for a
// body across all filesystem-store instances in this process so an append,
// heartbeat, takeover, and settlement cannot overwrite one another's fence.
const filesystemBodyMutationTails = new Map<string, Promise<void>>();

async function withFilesystemBodyMutationLock<T>(
  bodyId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = filesystemBodyMutationTails.get(bodyId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  filesystemBodyMutationTails.set(bodyId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (filesystemBodyMutationTails.get(bodyId) === tail) {
      filesystemBodyMutationTails.delete(bodyId);
    }
  }
}

export function createFilesystemBodyStore(
  options: Readonly<{
    backendId: string;
    protectionMs?: number;
    access: BodyFilesystemAccess;
  }>,
): BodyStore {
  const backendId = options.backendId.trim();
  if (!backendId) {
    throw new TypeError("Filesystem backendId must be non-empty.");
  }
  const protectionMs = bodyProtectionMs(options.protectionMs);
  const progressive = createFilesystemProgressive(options.access, protectionMs);
  const putReady = async (input: PutBodyInput): Promise<ReadyBodyHead> => {
    if ((await progressive.headAny(input.bodyId))?.state === "incomplete") {
      throw createContentError(
        "asset_conflict",
        "An incomplete body cannot be adopted as a Ready body.",
      );
    }
    const protectedUntil = resolveBodyProtectionUntil(
      input.protectedUntil,
      protectionMs,
    );
    const head = await options.access.acquireReady({
      ...input,
      protectedUntil,
    });
    validateHead(input, head);
    return head;
  };
  const store: BodyStore = {
    kind: "filesystem",
    backendId,
    put: (input) =>
      withFilesystemBodyMutationLock(
        input.bodyId,
        () => putReady(input),
      ),
    async head({ bodyId }) {
      return await options.access.stat(bodyId) ??
        await progressive.headAny(bodyId);
    },
    async read({ bodyId }) {
      const ready = await options.access.stat(bodyId);
      if (ready) return await options.access.openReady(bodyId);
      const staged = await progressive.headAny(bodyId);
      if (staged?.state !== "incomplete") {
        throw createContentError(
          "asset_not_found",
          "Body was not found in the configured filesystem backend.",
        );
      }
      if (staged.byteLength === 0) {
        return new ReadableStream({
          start: (controller) => controller.close(),
        });
      }
      return await options.access.openFrom(stagingDataKey(bodyId), 0);
    },
    async readRange(input) {
      const ready = await options.access.stat(input.bodyId);
      if (ready) {
        const start = Math.max(0, input.offset);
        const end = Math.min(input.end, ready.byteLength);
        if (end <= start) return new Uint8Array();
        return await readStreamRange(
          await options.access.openReadyFrom(input.bodyId, start),
          end - start,
        );
      }
      return await progressive.readRange(input);
    },
    async follow(input) {
      const offset = Math.max(0, input.offset ?? 0);
      const ready = await options.access.stat(input.bodyId);
      if (ready) {
        return await options.access.openReadyFrom(input.bodyId, offset);
      }
      const staged = await progressive.headAny(input.bodyId);
      if (!staged) {
        throw createContentError(
          "asset_not_found",
          "Body was not found in the configured filesystem backend.",
        );
      }
      if (offset >= staged.byteLength) {
        return new ReadableStream({
          start: (controller) => controller.close(),
        });
      }
      return await options.access.openFrom(
        stagingDataKey(input.bodyId),
        staged.state === "incomplete"
          ? offset
          : Math.max(offset, staged.discarded) - staged.discarded,
      );
    },
    reserve: (input) =>
      withFilesystemBodyMutationLock(
        input.bodyId,
        () => progressive.reserve(input),
      ),
    renew: (input) =>
      withFilesystemBodyMutationLock(
        input.writer.bodyId,
        () => progressive.renew(input),
      ),
    append: (input) =>
      withFilesystemBodyMutationLock(
        input.writer.bodyId,
        () => progressive.append(input),
      ),
    seal: (input) =>
      withFilesystemBodyMutationLock(input.writer.bodyId, async () => {
        const current = await progressive.beginSeal(input);
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
        const head = await putReady({
          bodyId: input.writer.bodyId,
          bytes,
          mediaType: current.mediaType,
          digest,
        });
        // Ready publication is irreversible. Cleanup is fenced separately and
        // an interruption stays enumerable as `sealing` for maintenance.
        await progressive.cleanupAfterSeal(input).catch(() => undefined);
        return head;
      }),
    terminate: (input) =>
      withFilesystemBodyMutationLock(
        input.writer.bodyId,
        () => progressive.terminate(input),
      ),
    abort: (input) =>
      withFilesystemBodyMutationLock(
        input.writer.bodyId,
        () => progressive.abort(input),
      ),
    maintenance: {
      async list(input) {
        if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
          throw new TypeError(
            "Body maintenance idle duration must be a non-negative integer.",
          );
        }
        const states = new Set<BodyState>(input.states);
        const bodies: (TerminalBodyHead | MutableBodyHead)[] = [];
        if (states.has("ready")) {
          for await (const body of options.access.list(input.prefix ?? "")) {
            if (bodyHasBeenIdle(body.lastModified, input.idleForMs)) {
              bodies.push(body);
            }
          }
        }
        if (
          options.access.listProgressive &&
          (states.has("open") || states.has("sealing") ||
            states.has("terminating") || states.has("incomplete"))
        ) {
          for await (const entry of options.access.listProgressive()) {
            if (!entry.bodyId.startsWith(input.prefix ?? "")) continue;
            if (!bodyHasBeenIdle(entry.lastModified, input.idleForMs)) continue;
            const body = await progressive.headAny(entry.bodyId);
            if (body && states.has(body.state)) bodies.push(body);
          }
        }
        bodies.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
        const after = input.after ?? "";
        const page = bodies.filter((body) => body.bodyId > after).slice(
          0,
          input.limit,
        );
        return Object.freeze({
          bodies: Object.freeze(page),
          ...(page.length === input.limit
            ? { after: page[page.length - 1].bodyId }
            : {}),
        });
      },
      delete: (input) =>
        withFilesystemBodyMutationLock(input.bodyId, async () => {
          if (!Number.isSafeInteger(input.idleForMs) || input.idleForMs < 0) {
            throw new TypeError(
              "Body maintenance idle duration must be a non-negative integer.",
            );
          }
          if (input.expectedState === "ready") {
            return await options.access.deleteReady(input);
          }
          if (input.expectedState !== "incomplete") return false;
          const current = await progressive.headAny(input.bodyId);
          if (
            current?.state !== "incomplete" ||
            current.maintenanceVersion !==
              input.expectedMaintenanceVersion ||
            bodyProtectionRemainingMs(current.protectedUntil) > 0 ||
            !bodyHasBeenIdle(current.lastModified, input.idleForMs)
          ) return false;
          if (options.access.cleanupProgressive) {
            await options.access.cleanupProgressive(input.bodyId);
          } else {
            await options.access.delete(stagingDataKey(input.bodyId));
            await options.access.delete(stagingMetaKey(input.bodyId));
          }
          return (await progressive.headAny(input.bodyId)) === null;
        }),
    },
  };
  return Object.freeze(store);
}

export async function readBodiesBounded<T>(
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
