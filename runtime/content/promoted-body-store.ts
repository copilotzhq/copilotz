import type {
  BodyStore,
  BodyStoreAdapter,
  ReadyBodyHead,
  TrustedBodyScope,
} from "./body-store.ts";
import type { ContentCatalog, ContentCopy } from "./catalog.ts";
import { readBodyBytes } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";

export type PromotedBodyStoreOptions = Readonly<
  { staging: BodyStore; ready: BodyStore }
>;
export type PromotedBodyStoreAdapterOptions = Readonly<
  { staging: BodyStoreAdapter; ready: BodyStoreAdapter }
>;
const targets = new WeakMap<BodyStore, BodyStore>();
/** Physical composition contains no promotion or cleanup side effects. */
export function createPromotedBodyStore(
  options: PromotedBodyStoreOptions,
): BodyStore {
  if (options.staging === options.ready) {
    throw new TypeError("Promotion requires distinct stores.");
  }
  const store = { ...options.staging };
  targets.set(store, options.ready);
  return store;
}
export function promotedReadyStore(store: BodyStore): BodyStore | undefined {
  return targets.get(store);
}
export function createPromotedBodyStoreAdapter(
  options: PromotedBodyStoreAdapterOptions,
): BodyStoreAdapter {
  for (const adapter of [options.staging, options.ready]) {
    if (
      adapter.deployment.durability !== "durable" ||
      adapter.deployment.reach !== "cluster"
    ) throw new TypeError("Promotion requires durable cluster stores.");
  }
  const stores = new Map<string, BodyStore>();
  const forScope = (scope: TrustedBodyScope) => {
    const key = JSON.stringify([scope.databaseSchema, scope.namespace]);
    let store = stores.get(key);
    if (!store) {
      store = createPromotedBodyStore({
        staging: options.staging.forScope(scope),
        ready: options.ready.forScope(scope),
      });
      stores.set(key, store);
    }
    return store;
  };
  return {
    deployment: options.ready.deployment,
    forScope,
    maintenanceForScope: (scope) => forScope(scope).maintenance,
  };
}
/** Reserve before upload; publish only an exact observed copy. Collection is separate. */
export async function promoteLogicalBody(
  input: {
    catalog: ContentCatalog;
    bodyId: string;
    storeFor: (copy: ContentCopy) => BodyStore;
    target: BodyStore;
    targetKey: string;
    expiresAt: string;
  },
): Promise<boolean> {
  const body = await input.catalog.read(input.bodyId);
  if (body?.terminal?.outcome !== "completed") {
    throw createContentError(
      "asset_conflict",
      "Promotion requires completed catalog content.",
    );
  }
  const target = {
    key: input.targetKey,
    backendKind: input.target.kind,
    backendId: input.target.backendId,
    collectable: input.target.conditionalDelete,
  };
  await input.catalog.reservePromotion({
    bodyId: body.bodyId,
    target,
    expiresAt: input.expiresAt,
  });
  let head: ReadyBodyHead | null = null;
  try {
    const bytes = await readBodyBytes(input.storeFor(body.copy), {
      bodyId: body.copy.key,
    });
    if (
      bytes.byteLength !== body.terminal.length ||
      await digestContent(bytes) !== body.terminal.digest
    ) {
      throw createContentError(
        "asset_corrupted",
        "Promotion source does not match accepted content.",
      );
    }
    const source = await input.storeFor(body.copy).head({
      bodyId: body.copy.key,
    });
    if (!source) {
      throw createContentError(
        "content_missing",
        "Promotion source disappeared.",
      );
    }
    await input.target.put({
      bodyId: target.key,
      bytes,
      mediaType: source.mediaType,
      digest: body.terminal.digest,
      ifAbsent: true,
    });
    const observed = await input.target.head({ bodyId: target.key });
    if (observed?.state === "ready") head = observed;
  } catch {
    // A write may have succeeded before its acknowledgement was lost.
    const observed = await input.target.head({ bodyId: target.key }).catch(() =>
      null
    );
    if (observed?.state === "ready") head = observed;
    if (!head) {
      await input.catalog.finishPromotion({
        bodyId: body.bodyId,
        targetKey: target.key,
        head: null,
      });
      return false;
    }
  }
  return await input.catalog.finishPromotion({
    bodyId: body.bodyId,
    targetKey: target.key,
    head,
  });
}

/** Owner completion policy for the configured staging/ready composition. */
export async function promoteConfiguredLogicalBody(
  input: {
    catalog: ContentCatalog;
    bodyId: string;
    storeFor: (copy: ContentCopy) => BodyStore;
  },
): Promise<boolean> {
  const body = await input.catalog.read(input.bodyId);
  if (!body) return false;
  const target = promotedReadyStore(input.storeFor(body.copy));
  if (!target) return false;
  return await promoteLogicalBody({
    ...input,
    target,
    targetKey: `${body.copy.key}/promoted/${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
}
