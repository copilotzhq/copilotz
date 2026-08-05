import type {
  AssetOperations,
  AssetSaveOptions,
  AssetStore,
  SavedAsset,
} from "./index.ts";
import { assetRefFor, extractAssetId } from "./index.ts";
import type {
  CollectionsManager,
  ScopedCollectionCrud,
  ScopedCollectionsManager,
} from "@/database/collections/types.ts";
import type { CollectionMutationScope } from "@/database/collections/event-manager.ts";

type EventCollections = CollectionsManager & {
  withMutationScope(
    namespace: string,
    scope: CollectionMutationScope,
  ): ScopedCollectionsManager;
};

interface AssetRecord extends Record<string, unknown> {
  id: string;
  ref: string;
  mime: string;
  threadId?: string | null;
  by?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
}

type AssetCrud = ScopedCollectionCrud<AssetRecord, Partial<AssetRecord>>;

export interface EventAssetService extends AssetOperations {
  scoped(defaults: AssetSaveOptions): AssetOperations;
}

function assetCollection(manager: ScopedCollectionsManager): AssetCrud {
  const collection = manager.asset;
  if (!collection || typeof collection !== "object") {
    throw new Error("The core asset collection is not available.");
  }
  return collection as AssetCrud;
}

/**
 * Couples byte persistence to event-native metadata. Bytes remain in the
 * injected store; the graph contains only references and semantic metadata.
 */
export function createEventAssetService(options: {
  store: AssetStore;
  collections: EventCollections;
  defaultNamespace?: string;
}): EventAssetService {
  const save = async (
    bytes: Uint8Array,
    mime: string,
    saveOptions: AssetSaveOptions = {},
  ): Promise<SavedAsset> => {
    const namespace = saveOptions.namespace ?? options.defaultNamespace ??
      "default";
    const stored = await options.store.save(bytes, mime);
    const proposedRef = assetRefFor(options.store, stored.assetId);
    const hasMutationScope = saveOptions.idempotencyKey ||
      saveOptions.causationId || saveOptions.correlationId ||
      saveOptions.metadata;
    const manager = hasMutationScope
      ? options.collections.withMutationScope(namespace, {
        causationId: saveOptions.causationId,
        correlationId: saveOptions.correlationId,
        idempotencyKey: saveOptions.idempotencyKey,
        metadata: saveOptions.metadata,
      })
      : options.collections.withNamespace(namespace);
    const record = await assetCollection(manager).create({
      id: stored.assetId,
      ref: proposedRef,
      mime,
      threadId: saveOptions.threadId ?? null,
      by: saveOptions.by ?? null,
      toolCallId: saveOptions.toolCallId ?? null,
      metadata: saveOptions.metadata ?? null,
    });
    const assetId = record.id;
    return {
      assetId,
      ref: typeof record.ref === "string"
        ? record.ref as SavedAsset["ref"]
        : assetRefFor(options.store, assetId),
      ...(assetId === stored.assetId && stored.info
        ? { info: stored.info }
        : options.store.info
        ? { info: await options.store.info(assetId) }
        : {}),
    };
  };

  const service: EventAssetService = {
    save,
    get: (id) => options.store.get(extractAssetId(id)),
    urlFor: (id, urlOptions) =>
      options.store.urlFor(extractAssetId(id), urlOptions),
    info: (id) =>
      options.store.info?.(extractAssetId(id)) ?? Promise.resolve(undefined),
    scoped(defaults) {
      let operation = 0;
      return {
        save: (bytes, mime, overrides) => {
          const options = { ...defaults, ...overrides };
          const rootKey = options.idempotencyKey;
          const idempotencyKey = rootKey
            ? `${rootKey}:${operation++}`
            : undefined;
          return save(bytes, mime, { ...options, idempotencyKey });
        },
        get: service.get,
        urlFor: service.urlFor,
        info: service.info,
      };
    },
  };
  return service;
}
