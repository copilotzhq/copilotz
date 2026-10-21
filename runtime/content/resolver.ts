import { createContentBodyDecoder } from "./decode.ts";
import { digestContent } from "./digest.ts";
import { createContentByteLimitError, createContentError } from "./errors.ts";
import { planContentBudget } from "./budget.ts";
import type {
  AssetBody,
  AssetRepository,
  AuthorizeContent,
  ContentBudget,
  ContentRef,
  DeferredAssetBody,
  DeferredContent,
  ResolveContentOptions,
  ResolvedContent,
} from "./types.ts";

/** `getMany` with `overflow: "defer"` resolves what fits and defers the rest. */
export type ResolveManyContent = {
  (
    refs: readonly ContentRef[],
    options: ResolveContentOptions & { maxBytes: number; overflow: "defer" },
  ): Promise<readonly (ResolvedContent | DeferredContent)[]>;
  (
    refs: readonly ContentRef[],
    options: ResolveContentOptions,
  ): Promise<readonly ResolvedContent[]>;
};

export type ContentResolver = {
  authorize(ref: ContentRef, options: ResolveContentOptions): Promise<void>;
  get(
    ref: ContentRef,
    options: ResolveContentOptions,
  ): Promise<ResolvedContent>;
  /**
   * Resolves references, reading each unique body once. With `maxBytes` the
   * unique bodies are budgeted from metadata before any read: by default a
   * read over budget rejects as a whole; with `overflow: "defer"` the bodies
   * that fit resolve in the order given and the rest return as
   * `DeferredContent` (see `planContentBudget`).
   */
  getMany: ResolveManyContent;
  open(
    ref: ContentRef,
    options: ResolveContentOptions,
  ): Promise<ReadableStream<Uint8Array>>;
};

async function requireAuthorization(
  authorize: AuthorizeContent | undefined,
  ref: ContentRef,
  options: ResolveContentOptions,
): Promise<void> {
  if (!authorize) return;
  const allowed = await authorize({
    namespace: options.namespace,
    ref,
    action: "read",
  });
  if (!allowed) {
    throw createContentError(
      "content_unauthorized",
      `Content access denied for asset: ${ref.assetId}`,
      { namespace: options.namespace, assetId: ref.assetId },
    );
  }
}

async function prepareBody(
  assetId: string,
  body: AssetBody,
  namespace: string,
  digest: (bytes: Uint8Array) => Promise<`sha256:${string}`>,
): Promise<(ref: ContentRef) => ResolvedContent> {
  const { asset } = body;
  if (asset.id !== assetId || asset.namespace !== namespace) {
    throw createContentError(
      "asset_corrupted",
      `Asset repository returned the wrong body for: ${assetId}`,
      { namespace, assetId },
    );
  }
  if (asset.state === "deleted") {
    throw createContentError(
      "asset_deleted",
      `Asset has been deleted: ${assetId}`,
      { namespace, assetId },
    );
  }
  if (asset.state !== "ready") {
    throw createContentError(
      "asset_not_ready",
      `Asset is not ready: ${assetId}`,
      { namespace, assetId },
    );
  }
  if (asset.byteLength !== body.bytes.byteLength) {
    throw createContentError(
      "asset_corrupted",
      `Asset byte length does not match its body: ${assetId}`,
      { namespace, assetId },
    );
  }
  if (await digest(body.bytes) !== asset.digest) {
    throw createContentError(
      "asset_corrupted",
      `Asset digest does not match its body: ${assetId}`,
      { namespace, assetId },
    );
  }

  const decode = createContentBodyDecoder(body.bytes, { namespace, assetId });
  return (ref) => {
    if (asset.mediaType !== ref.mediaType) {
      throw createContentError(
        "asset_corrupted",
        `Asset media type does not match its content reference: ${ref.assetId}`,
        { namespace, assetId: ref.assetId },
      );
    }
    const resolved: ResolvedContent = {
      ref: structuredClone(ref),
      asset: structuredClone(asset),
      bytes: body.bytes.slice(),
    };
    if (ref.kind === "text" || ref.kind === "json") {
      const value = decode(ref.kind);
      resolved.text = value.text;
      if (ref.kind === "json") resolved.value = value.value;
    }
    return resolved;
  };
}

/** Creates an authorization-aware, integrity-checking content resolver. */
export function createContentResolver(dependencies: {
  assets: AssetRepository;
  authorize?: AuthorizeContent;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
}): ContentResolver {
  const digest = dependencies.digest ?? digestContent;

  const readBodies = async (
    namespace: string,
    ids: readonly string[],
    budget: ContentBudget | undefined,
  ): Promise<readonly (AssetBody | DeferredAssetBody)[]> => {
    if (!budget) return await dependencies.assets.readMany(namespace, ids);
    if (dependencies.assets.readWithin) {
      return await dependencies.assets.readWithin(namespace, ids, budget);
    }
    // Repositories without `readWithin`: plan from metadata, then read.
    const assets = await dependencies.assets.getMany(namespace, ids);
    const plan = planContentBudget(assets, budget);
    const wanted = ids.filter((_, index) => plan[index] === "read");
    const bodies = new Map(
      (wanted.length
        ? await dependencies.assets.readMany(namespace, wanted)
        : []).map((body, index) => [wanted[index], body]),
    );
    return ids.map((id, index) =>
      plan[index] === "read"
        ? bodies.get(id)!
        : { asset: assets[index], deferred: plan[index] as "budget" | "size" }
    );
  };

  const resolveMany = async (
    refs: readonly ContentRef[],
    options: ResolveContentOptions,
  ): Promise<readonly (ResolvedContent | DeferredContent)[]> => {
    options.signal?.throwIfAborted();
    for (
      const [name, value] of [
        ["maxBytes", options.maxBytes],
        ["maxBodyBytes", options.maxBodyBytes],
      ] as const
    ) {
      if (
        value !== undefined && (!Number.isSafeInteger(value) || value < 0)
      ) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
      }
    }
    const defer = options.overflow === "defer" &&
      options.maxBytes !== undefined;
    for (const ref of refs) {
      options.signal?.throwIfAborted();
      await requireAuthorization(dependencies.authorize, ref, options);
    }
    options.signal?.throwIfAborted();
    const ids = [...new Set(refs.map((ref) => ref.assetId))];
    if (!ids.length) return ([] as const);
    // The repository decides from the metadata it already holds, so a
    // bounded read costs the same round trip as an unbounded one.
    const bodies = defer
      ? await readBodies(options.namespace, ids, {
        maxBytes: options.maxBytes!,
        ...(options.maxBodyBytes === undefined
          ? {}
          : { maxBodyBytes: options.maxBodyBytes }),
      })
      : await dependencies.assets.readMany(
        options.namespace,
        ids,
        options.maxBytes === undefined
          ? undefined
          : { maxBytes: options.maxBytes },
      );
    options.signal?.throwIfAborted();
    if (bodies.length !== ids.length) {
      throw createContentError(
        "asset_corrupted",
        "Asset repository returned an incomplete content batch.",
        { namespace: options.namespace },
      );
    }
    const deferred = new Map<string, DeferredAssetBody>();
    const read: AssetBody[] = [];
    const readers = new Map(
      await Promise.all(ids.flatMap((id, index) => {
        const body = bodies[index];
        if ("deferred" in body) {
          if (body.asset.id !== id) {
            throw createContentError(
              "asset_corrupted",
              `Asset repository returned the wrong body for: ${id}`,
              { namespace: options.namespace, assetId: id },
            );
          }
          deferred.set(id, body);
          return [];
        }
        read.push(body);
        // Identity and integrity are checked once for each unique body.
        return [(async () =>
          [
            id,
            await prepareBody(id, body, options.namespace, digest),
          ] as const)()];
      })),
    );
    const resolved = refs.map((ref): ResolvedContent | DeferredContent => {
      const later = deferred.get(ref.assetId);
      return later
        ? {
          ref: structuredClone(ref),
          asset: structuredClone(later.asset),
          deferred: later.deferred,
        }
        : readers.get(ref.assetId)!(ref);
    });
    options.signal?.throwIfAborted();
    const total = read.reduce((sum, body) => sum + body.bytes.byteLength, 0);
    if (options.maxBytes !== undefined && total > options.maxBytes) {
      throw createContentByteLimitError(total, options.maxBytes);
    }
    return resolved;
  };
  const getMany = resolveMany as ResolveManyContent;

  const get: ContentResolver["get"] = async (ref, options) => {
    if (options.maxBytes !== undefined) {
      // One body is resolved or refused; it is never deferred.
      const [item] = await resolveMany([ref], {
        ...options,
        overflow: "reject",
      });
      return item as ResolvedContent;
    }
    options.signal?.throwIfAborted();
    await requireAuthorization(dependencies.authorize, ref, options);
    options.signal?.throwIfAborted();
    const body = await dependencies.assets.read(options.namespace, ref.assetId);
    const resolve = await prepareBody(
      ref.assetId,
      body,
      options.namespace,
      digest,
    );
    const resolved = resolve(ref);
    options.signal?.throwIfAborted();
    return resolved;
  };

  const open: ContentResolver["open"] = async (ref, options) => {
    const resolved = await get(ref, options);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(resolved.bytes);
        controller.close();
      },
    });
  };

  const authorize: ContentResolver["authorize"] = async (ref, options) => {
    options.signal?.throwIfAborted();
    await requireAuthorization(dependencies.authorize, ref, options);
    options.signal?.throwIfAborted();
  };
  return { get, getMany, open, authorize };
}
