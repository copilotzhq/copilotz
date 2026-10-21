/** Stable identity for one immutable durable content body. */
export type AssetId = string;

/** Lifecycle of a canonical content asset. */
export type AssetState =
  | "staging"
  | "ready"
  | "failed"
  | "abandoned"
  | "deleted";

/** Opaque provenance identity used for storage layout and correlation. */
export type AssetOrigin = Readonly<{ type: string; id: string }>;

/** Replay authority for one Asset materialized by a stable graph mutation. */
export type AssetManifestEntry = Readonly<{
  assetId: string;
  bodyId: string;
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  idempotencyKey?: string;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt: string;
  readyAt?: string;
}>;

/** Immutable replay authority for standalone Asset lifecycle mutations. */
export type AssetEventBody =
  | Readonly<{
    operation: "create";
    asset: AssetRecord;
    bodyId: string;
    idempotencyKey?: string;
  }>
  | Readonly<{
    operation: "delete";
    asset: AssetRecord;
    bodyId: string;
    idempotencyKey?: string;
  }>;

/** Physical placement of an asset body. */
export type AssetBodyLocation =
  | {
    kind: "database";
    key: string;
  }
  | {
    kind: "memory";
    backendId?: string;
    key?: string;
  }
  | {
    kind: "object";
    backendId: string;
    key: string;
    etag?: string;
  };

/** Canonical metadata for one immutable content body. */
export interface AssetRecord {
  id: AssetId;
  namespace: string;
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  state: AssetState;
  bodyId: string;
  origin?: AssetOrigin;
  createdAt: string;
  readyAt?: string;
  deletedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Semantic kind of a referenced content body. */
export type ContentKind =
  | "text"
  | "json"
  | "image"
  | "audio"
  | "video"
  | "file";

/** Common roles; applications and plugins may use additional stable strings. */
export type ContentRole = string;

/** Domain-safe pointer to a content body. Storage locators stay private. */
export interface ContentRef {
  assetId: AssetId;
  kind: ContentKind;
  role: ContentRole;
  mediaType: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Record<string, unknown>;
}

/** Data-only pointer to catalog-protected generated output, before a domain
 * record adopts it. These immutable claims support equivalence checks, but are
 * not authority: the owner resolves the descriptor and verifies provenance.
 * Semantic metadata and physical locations remain in the owner catalog. */
export type PendingContentRef = Readonly<{
  type: "content.pending";
  pendingRef: string;
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
}>;

/** Producer outputs may refer to pending content; persisted domain content may not. */
export type GeneratedContentSequence =
  readonly (ContentRef | PendingContentRef)[];

/** Ordered canonical content owned by a message, tool, event, or document. */
export type ContentSequence = readonly ContentRef[];

/** Immutable body prepared at an API boundary but not yet made durable. */
export type PreparedAsset = Readonly<{
  id: AssetId;
  namespace: string;
  mediaType: string;
  /** Byte-backed candidates come from ingress preparation. */
  body: Uint8Array;
  /** Ready Body-backed candidates come from protected workflow settlement. */
  readyBody?: import("./body-store.ts").ReadyBodyHead;
  location?: AssetBodyLocation;
  logicalBodyId?: string;
  pendingAdoption?: Readonly<{ pendingRef: string; ownerId: string }>;
  byteLength: number;
  digest: `sha256:${string}`;
  idempotencyKey?: string;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}>;

/** Ordered refs plus the new bodies an aggregate mutation must materialize. */
export type PreparedContent = Readonly<{
  content: ContentSequence;
  assets: readonly PreparedAsset[];
}>;

/** Canonical refs may be supplied directly when every body already exists. */
export type DurableContentInput = GeneratedContentSequence | PreparedContent;

/** One new Asset whose durable body and graph metadata are ready for adoption. */
export type AssetAdoptionPlan = Readonly<{
  /** Database bodies join the graph transaction; ready bodies need no write. */
  kind: "database" | "ready";
  candidate: PreparedAsset;
  asset: AssetRecord;
}>;

/** Preflighted content that can be adopted without external I/O. */
export type AssetMaterializationPlan = Readonly<{
  namespace: string;
  content: ContentSequence;
  assets: readonly AssetManifestEntry[];
  adoptions: readonly AssetAdoptionPlan[];
}>;

/** Input accepted by the canonical content normalizer. */
export type ContentInput =
  | string
  | ContentRef
  | {
    type: "text";
    text: string;
    role?: ContentRole;
    mediaType?: string;
    name?: string;
    language?: string;
    metadata?: Record<string, unknown>;
    origin?: AssetOrigin;
  }
  | {
    type: "json";
    value: unknown;
    role?: ContentRole;
    mediaType?: string;
    name?: string;
    metadata?: Record<string, unknown>;
    origin?: AssetOrigin;
  }
  | {
    type: "image" | "audio" | "video" | "file";
    bytes: Uint8Array;
    mediaType: string;
    role?: ContentRole;
    name?: string;
    alt?: string;
    language?: string;
    disposition?: "inline" | "attachment";
    metadata?: Record<string, unknown>;
    origin?: AssetOrigin;
  };

/** Context used to publish normalized content. */
export interface NormalizeContentOptions {
  namespace: string;
  idempotencyKey?: string;
  origin?: AssetOrigin;
}

/** Input for publishing one immutable body. */
export interface PublishAssetInput {
  namespace: string;
  mediaType: string;
  body: Uint8Array;
  id?: AssetId;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  origin?: AssetOrigin;
  location?: AssetBodyLocation;
}

/** Canonical record and bytes returned together to avoid N+1 resolution. */
export interface AssetBody {
  asset: AssetRecord;
  bytes: Uint8Array;
}

/**
 * Why a budgeted read left a body unread: `size` when the body alone exceeds
 * the per-body limit, `budget` when the bodies before it used the budget.
 */
export type ContentDeferral = "budget" | "size";

/** A budgeted read's limits: unique bytes in all, and bytes per body. */
export interface ContentBudget {
  maxBytes: number;
  /** Defaults to `maxBytes`. */
  maxBodyBytes?: number;
}

/** A body a budgeted read did not read; its metadata (and size) is known. */
export interface DeferredAssetBody {
  asset: AssetRecord;
  deferred: ContentDeferral;
}

/**
 * What a repository needs of the runtime's per-handler read view: remember
 * rows a handler has read, and forget them when this runtime changes them.
 */
export interface ReadViewAccess {
  memo(): {
    recall<T>(key: string): { value: T } | undefined;
    begin(keys: readonly string[]): {
      remember(key: string, value: unknown): void;
    };
  } | undefined;
  invalidate(key: string): void;
  invalidateAll(): void;
}

/** Storage-neutral contract consumed by normalization and projection code. */
export interface AssetRepository {
  publish(input: PublishAssetInput): Promise<AssetRecord>;
  get(namespace: string, assetId: AssetId): Promise<AssetRecord | null>;
  getMany(
    namespace: string,
    assetIds: readonly AssetId[],
  ): Promise<readonly AssetRecord[]>;
  read(namespace: string, assetId: AssetId): Promise<AssetBody>;
  /**
   * Reads unique bodies in one metadata round trip. With `maxBytes` the
   * repository rejects an oversized batch from the metadata it already holds,
   * before it reads any body.
   */
  readMany(
    namespace: string,
    assetIds: readonly AssetId[],
    options?: { maxBytes?: number },
  ): Promise<readonly AssetBody[]>;
  /**
   * Reads, in the order given, the unique bodies that fit `budget` and defers
   * the rest (see `planContentBudget`), deciding from metadata in the same
   * round trip as `readMany`. Repositories without it are budgeted from
   * `getMany` metadata by the resolver.
   */
  readWithin?(
    namespace: string,
    assetIds: readonly AssetId[],
    budget: ContentBudget,
  ): Promise<readonly (AssetBody | DeferredAssetBody)[]>;
  open(
    namespace: string,
    assetId: AssetId,
  ): Promise<ReadableStream<Uint8Array>>;
  markDeleted(namespace: string, assetId: AssetId): Promise<AssetRecord>;
}

/** Fully resolved body plus safe decoded projections when applicable. */
export interface ResolvedContent {
  ref: ContentRef;
  asset: AssetRecord;
  bytes: Uint8Array;
  text?: string;
  value?: unknown;
}

/** A reference a budgeted read deferred: authorized, its size known, unread. */
export interface DeferredContent {
  ref: ContentRef;
  asset: AssetRecord;
  deferred: ContentDeferral;
}

export type ResolveContentOptions = {
  namespace: string;
  signal?: AbortSignal;
  /** Maximum aggregate unique body bytes, checked against metadata before reads. */
  maxBytes?: number;
  /**
   * With `overflow: "defer"`, the most bytes one body may have before it is
   * deferred on its own (defaults to `maxBytes`).
   */
  maxBodyBytes?: number;
  /**
   * With `maxBytes`: `reject` (the default) fails a read over budget; `defer`
   * resolves the bodies that fit, in the order given, and returns the rest as
   * `DeferredContent`.
   */
  overflow?: "reject" | "defer";
};

export type ContentAuthorizationAction = "metadata" | "read";

export type AuthorizeContent = (input: {
  namespace: string;
  ref: ContentRef;
  action: ContentAuthorizationAction;
}) => boolean | Promise<boolean>;

export type ContentErrorCode =
  | "asset_conflict"
  | "asset_corrupted"
  | "asset_deleted"
  | "asset_not_ready"
  | "asset_not_found"
  | "asset_storage_unavailable"
  | "content_missing"
  | "content_invalid"
  | "content_unauthorized";

export type ContentError = Error & {
  code: ContentErrorCode;
  assetId?: string;
  namespace?: string;
};

/** JSON values carried by resolved content bodies. */
export type ContentJsonValue =
  | null
  | boolean
  | number
  | string
  | ContentJsonValue[]
  | { [key: string]: ContentJsonValue };
/** Decoded body value shared by Actions and Collections. */
export type ContentBodyValue = ContentJsonValue | Uint8Array;

/** Final reference and Asset semantics captured before physical sealing. */
export type PendingContentDescriptor = Readonly<{
  reference: Readonly<Omit<ContentRef, "assetId" | "mediaType">>;
  asset: Readonly<
    { origin?: AssetOrigin; metadata: Readonly<Record<string, unknown>> }
  >;
}>;
