/** Stable identity for one immutable durable content body. */
export type AssetId = string;

/** Lifecycle of a canonical content asset. */
export type AssetState =
  | "staging"
  | "ready"
  | "failed"
  | "abandoned"
  | "deleted";

/** Immutable provenance used for storage layout and operational correlation. */
export type AssetOrigin = Readonly<{
  scope:
    | Readonly<{ type: "thread"; id: string }>
    | Readonly<{ type: "collection"; collection: string; id: string }>
    | Readonly<{ type: "namespace"; id: string }>;
  producer: Readonly<{ type: string; id: string }>;
  path?: string;
  inferred?: boolean;
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
    kind: "filesystem";
    backendId: string;
    key: string;
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
  location: AssetBodyLocation;
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
export type ContentRole =
  | "body"
  | "attachment"
  | "reasoning"
  | "tool.arguments"
  | "tool.output"
  | "tool.projected_output"
  | "tool.error_detail"
  | "transcript"
  | "recording"
  | "document.source"
  | "provider.trace";

/** Domain-safe pointer to a content body. Storage locators stay private. */
export interface ContentRef {
  assetId: AssetId;
  kind: ContentKind;
  role: ContentRole | string;
  mediaType: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Record<string, unknown>;
}

/** Ordered canonical content owned by a message, tool, event, or document. */
export type ContentSequence = readonly ContentRef[];

/** Immutable body prepared at an API boundary but not yet made durable. */
export type PreparedAsset = Readonly<{
  id: AssetId;
  namespace: string;
  mediaType: string;
  body: Uint8Array;
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
export type DurableContentInput = ContentSequence | PreparedContent;

/** Input accepted by the canonical content normalizer. */
export type ContentInput =
  | string
  | ContentRef
  | {
    type: "text";
    text: string;
    role?: ContentRole | string;
    mediaType?: string;
    name?: string;
    language?: string;
    metadata?: Record<string, unknown>;
    origin?: AssetOrigin;
  }
  | {
    type: "json";
    value: unknown;
    role?: ContentRole | string;
    mediaType?: string;
    name?: string;
    metadata?: Record<string, unknown>;
    origin?: AssetOrigin;
  }
  | {
    type: "image" | "audio" | "video" | "file";
    bytes: Uint8Array;
    mediaType: string;
    role?: ContentRole | string;
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

/** Storage-neutral contract consumed by normalization and projection code. */
export interface AssetRepository {
  publish(input: PublishAssetInput): Promise<AssetRecord>;
  get(namespace: string, assetId: AssetId): Promise<AssetRecord | null>;
  getMany(
    namespace: string,
    assetIds: readonly AssetId[],
  ): Promise<readonly AssetRecord[]>;
  read(namespace: string, assetId: AssetId): Promise<AssetBody>;
  readMany(
    namespace: string,
    assetIds: readonly AssetId[],
  ): Promise<readonly AssetBody[]>;
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

export type ResolveContentOptions = {
  namespace: string;
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
  | "content_invalid"
  | "content_unauthorized";

export type ContentError = Error & {
  code: ContentErrorCode;
  assetId?: string;
  namespace?: string;
};
