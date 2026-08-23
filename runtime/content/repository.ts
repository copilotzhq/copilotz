import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import type {
  AssetBody,
  AssetOrigin,
  AssetRecord,
  AssetRepository,
  PublishAssetInput,
} from "./types.ts";

export type CreateMemoryAssetRepositoryOptions = {
  createId?: () => string;
  now?: () => Date;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
};

function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : structuredClone(metadata);
}

function cloneOrigin(origin: AssetOrigin | undefined): AssetOrigin | undefined {
  if (!origin) return undefined;
  const prototype = Object.getPrototypeOf(origin);
  const keys = Reflect.ownKeys(origin);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 || !keys.includes("type") || !keys.includes("id") ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(origin, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    }) ||
    typeof origin.type !== "string" || !origin.type.trim() ||
    typeof origin.id !== "string" || !origin.id.trim()
  ) {
    throw createContentError(
      "content_invalid",
      "Asset origin must contain exactly non-empty type and id.",
    );
  }
  return Object.freeze({ type: origin.type.trim(), id: origin.id.trim() });
}

function cloneRecord(record: AssetRecord): AssetRecord {
  return {
    ...record,
    location: { ...record.location },
    origin: cloneOrigin(record.origin),
    metadata: cloneMetadata(record.metadata),
  };
}

function cloneBody(body: AssetBody): AssetBody {
  return {
    asset: cloneRecord(body.asset),
    bytes: body.bytes.slice(),
  };
}

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw createContentError(
      "content_invalid",
      "A Web Crypto randomUUID implementation is required to publish content.",
    );
  }
  return globalThis.crypto.randomUUID();
}

function recordKey(namespace: string, assetId: string): string {
  return `${namespace}\0${assetId}`;
}

function idempotencyKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function assertPublishInput(input: PublishAssetInput): void {
  if (!input.namespace.trim()) {
    throw createContentError(
      "content_invalid",
      "Asset namespace must be a non-empty string.",
    );
  }
  if (!input.mediaType.trim()) {
    throw createContentError(
      "content_invalid",
      "Asset mediaType must be a non-empty string.",
      { namespace: input.namespace },
    );
  }
  if (!(input.body instanceof Uint8Array)) {
    throw createContentError(
      "content_invalid",
      "Asset body must be a Uint8Array.",
      { namespace: input.namespace },
    );
  }
}

/**
 * Creates an immutable, tenant-scoped asset repository for embedded and test
 * runtimes. The contract is storage-neutral; database and object-backed
 * implementations can replace this factory without changing consumers.
 */
export function createMemoryAssetRepository(
  options: CreateMemoryAssetRepositoryOptions = {},
): AssetRepository {
  const records = new Map<string, AssetRecord>();
  const bodies = new Map<string, Uint8Array>();
  const idempotency = new Map<string, string>();
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? (() => new Date());
  const digest = options.digest ?? digestContent;

  const requireRecord = (namespace: string, assetId: string): AssetRecord => {
    const record = records.get(recordKey(namespace, assetId));
    if (!record) {
      throw createContentError(
        "asset_not_found",
        `Asset not found: ${assetId}`,
        { namespace, assetId },
      );
    }
    return record;
  };

  const requireReadable = (namespace: string, assetId: string): AssetBody => {
    const record = requireRecord(namespace, assetId);
    if (record.state === "deleted") {
      throw createContentError(
        "asset_deleted",
        `Asset has been deleted: ${assetId}`,
        { namespace, assetId },
      );
    }
    if (record.state !== "ready") {
      throw createContentError(
        "asset_not_ready",
        `Asset is not ready: ${assetId}`,
        { namespace, assetId },
      );
    }
    const bytes = bodies.get(recordKey(namespace, assetId));
    if (!bytes) {
      throw createContentError(
        "asset_corrupted",
        `Asset body is unavailable: ${assetId}`,
        { namespace, assetId },
      );
    }
    return { asset: record, bytes };
  };

  return {
    async publish(input) {
      assertPublishInput(input);
      const namespace = input.namespace.trim();
      const mediaType = input.mediaType.trim();
      const body = input.body.slice();
      const bodyDigest = await digest(body);
      const dedupe = input.idempotencyKey?.trim();

      if (dedupe) {
        const existingId = idempotency.get(
          idempotencyKey(namespace, dedupe),
        );
        if (existingId) {
          const existing = requireRecord(namespace, existingId);
          if (
            existing.state !== "ready" ||
            existing.mediaType !== mediaType ||
            existing.digest !== bodyDigest ||
            existing.byteLength !== body.byteLength
          ) {
            throw createContentError(
              "asset_conflict",
              `Asset idempotency key was reused with different content: ${dedupe}`,
              { namespace, assetId: existingId },
            );
          }
          return cloneRecord(existing);
        }
      }

      const id = input.id?.trim() || createId();
      const key = recordKey(namespace, id);
      if (records.has(key)) {
        throw createContentError(
          "asset_conflict",
          `Asset ID already exists: ${id}`,
          { namespace, assetId: id },
        );
      }

      const timestamp = now().toISOString();
      const record: AssetRecord = {
        id,
        namespace,
        mediaType,
        byteLength: body.byteLength,
        digest: bodyDigest,
        state: "ready",
        location: input.location ?? { kind: "memory" },
        createdAt: timestamp,
        readyAt: timestamp,
        origin: cloneOrigin(input.origin) ?? Object.freeze({
          type: "namespace",
          id: namespace,
        }),
        metadata: cloneMetadata(input.metadata),
      };
      records.set(key, record);
      bodies.set(key, body);
      if (dedupe) {
        idempotency.set(idempotencyKey(namespace, dedupe), id);
      }
      return cloneRecord(record);
    },

    get(namespace, assetId) {
      const record = records.get(recordKey(namespace, assetId));
      return Promise.resolve(record ? cloneRecord(record) : null);
    },

    getMany(namespace, assetIds) {
      return Promise.resolve().then(() =>
        assetIds.map((assetId) =>
          cloneRecord(requireRecord(namespace, assetId))
        )
      );
    },

    read(namespace, assetId) {
      return Promise.resolve().then(() =>
        cloneBody(requireReadable(namespace, assetId))
      );
    },

    readMany(namespace, assetIds) {
      return Promise.resolve().then(() =>
        assetIds.map((assetId) =>
          cloneBody(requireReadable(namespace, assetId))
        )
      );
    },

    open(namespace, assetId) {
      return Promise.resolve().then(() => {
        const { bytes } = cloneBody(requireReadable(namespace, assetId));
        return (
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          })
        );
      });
    },

    markDeleted(namespace, assetId) {
      return Promise.resolve().then(() => {
        const existing = requireRecord(namespace, assetId);
        if (existing.state === "deleted") {
          return cloneRecord(existing);
        }
        const deleted: AssetRecord = {
          ...existing,
          state: "deleted",
          deletedAt: now().toISOString(),
        };
        const key = recordKey(namespace, assetId);
        records.set(key, deleted);
        bodies.delete(key);
        return cloneRecord(deleted);
      });
    },
  };
}
