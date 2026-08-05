/** Runtime-neutral asset contracts and in-memory stores. */

export type AssetId = string;
export type AssetRef = `asset://${string}`;

export interface AssetConfig {
  inlineThresholdBytes?: number;
  resolveInLLM?: boolean;
  backend?: "memory" | "passthrough";
}

export interface AssetInfo {
  id: AssetId;
  mime: string;
  size: number;
  createdAt: Date;
}

export interface AssetStore {
  save(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ assetId: AssetId; info?: AssetInfo }>;
  get(assetId: AssetId): Promise<{ bytes: Uint8Array; mime: string }>;
  urlFor(assetId: AssetId, options?: { inline?: boolean }): Promise<string>;
  info?(assetId: AssetId): Promise<AssetInfo | undefined>;
  namespace?: string;
  includeNamespaceInRef?: boolean;
  refFor?(assetId: AssetId): AssetRef;
}

export interface AssetSaveOptions {
  namespace?: string;
  threadId?: string;
  by?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
  /** Stable operation root used by delivery-scoped asset writes. */
  idempotencyKey?: string;
}

export interface SavedAsset {
  assetId: AssetId;
  ref: AssetRef;
  info?: AssetInfo;
}

/** Event-aware asset API exposed by engines and tool contexts. */
export interface AssetOperations {
  save(
    bytes: Uint8Array,
    mime: string,
    options?: AssetSaveOptions,
  ): Promise<SavedAsset>;
  get(assetIdOrRef: AssetId | AssetRef): Promise<{
    bytes: Uint8Array;
    mime: string;
  }>;
  urlFor(
    assetIdOrRef: AssetId | AssetRef,
    options?: { inline?: boolean },
  ): Promise<string>;
  info(assetIdOrRef: AssetId | AssetRef): Promise<AssetInfo | undefined>;
}

export function isAssetRef(value: unknown): value is AssetRef {
  return typeof value === "string" && value.startsWith("asset://");
}

export function extractAssetId(ref: AssetRef | string): AssetId {
  if (!isAssetRef(ref)) return ref as AssetId;
  const raw = ref.slice("asset://".length);
  const separator = raw.indexOf("/");
  return (separator < 0 ? raw : raw.slice(separator + 1)) as AssetId;
}

export function assetRefFor(store: AssetStore, assetId: AssetId): AssetRef {
  return store.refFor?.(assetId) ?? (`asset://${assetId}` as AssetRef);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function parseDataUrl(
  value: string,
): { mime: string; bytes: Uint8Array } | null {
  if (!value.startsWith("data:")) return null;
  const separator = value.indexOf(",");
  if (separator < 0) return null;
  try {
    const metadata = value.slice(5, separator);
    const mime = metadata.split(";")[0] || "application/octet-stream";
    const encoded = value.slice(separator + 1);
    return {
      mime,
      bytes: metadata.includes(";base64")
        ? base64ToBytes(encoded)
        : new TextEncoder().encode(decodeURIComponent(encoded)),
    };
  } catch {
    return null;
  }
}

type StoredAsset = { bytes: Uint8Array; mime: string; createdAt: Date };

function storeAsset(
  values: Map<AssetId, StoredAsset>,
  bytes: Uint8Array,
  mime: string,
): { assetId: AssetId; info: AssetInfo } {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Asset bytes must be a Uint8Array.");
  }
  const assetId = crypto.randomUUID();
  const createdAt = new Date();
  const normalizedMime = mime || "application/octet-stream";
  values.set(assetId, {
    bytes: bytes.slice(),
    mime: normalizedMime,
    createdAt,
  });
  return {
    assetId,
    info: {
      id: assetId,
      mime: normalizedMime,
      size: bytes.byteLength,
      createdAt,
    },
  };
}

function assetInfo(
  assetId: AssetId,
  value?: StoredAsset,
): AssetInfo | undefined {
  return value
    ? {
      id: assetId,
      mime: value.mime,
      size: value.bytes.byteLength,
      createdAt: value.createdAt,
    }
    : undefined;
}

export function createMemoryAssetStore(config: AssetConfig = {}): AssetStore {
  const values = new Map<AssetId, StoredAsset>();
  const threshold = Math.max(0, config.inlineThresholdBytes ?? 256_000);
  return {
    save: (bytes, mime) => Promise.resolve(storeAsset(values, bytes, mime)),
    get: (assetId) => {
      const value = values.get(assetId);
      if (!value) throw new Error(`Asset not found: ${assetId}`);
      return Promise.resolve({ bytes: value.bytes.slice(), mime: value.mime });
    },
    urlFor: (assetId, options) => {
      const value = values.get(assetId);
      if (!value) throw new Error(`Asset not found: ${assetId}`);
      void (options?.inline ?? value.bytes.byteLength <= threshold);
      return Promise.resolve(toDataUrl(value.bytes, value.mime));
    },
    info: (assetId) => Promise.resolve(assetInfo(assetId, values.get(assetId))),
  };
}

export function createPassthroughAssetStore(): AssetStore {
  const values = new Map<AssetId, StoredAsset>();
  return {
    save: (bytes, mime) => Promise.resolve(storeAsset(values, bytes, mime)),
    get: (assetId) => {
      const value = values.get(assetId);
      if (!value) throw new Error(`Asset not found: ${assetId}`);
      values.delete(assetId);
      return Promise.resolve({ bytes: value.bytes, mime: value.mime });
    },
    urlFor: (assetId) => {
      const value = values.get(assetId);
      if (!value) throw new Error(`Asset not found: ${assetId}`);
      return Promise.resolve(toDataUrl(value.bytes, value.mime));
    },
    info: (assetId) => Promise.resolve(assetInfo(assetId, values.get(assetId))),
  };
}

export function createAssetStore(config: AssetConfig = {}): AssetStore {
  return config.backend === "passthrough"
    ? createPassthroughAssetStore()
    : createMemoryAssetStore(config);
}
