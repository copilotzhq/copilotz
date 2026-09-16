import { createContentBodyDecoder } from "./decode.ts";
import { digestContent } from "./digest.ts";
import { createContentByteLimitError, createContentError } from "./errors.ts";
import type {
  AssetBody,
  AssetRepository,
  AuthorizeContent,
  ContentRef,
  ResolveContentOptions,
  ResolvedContent,
} from "./types.ts";

export type ContentResolver = {
  authorize(ref: ContentRef, options: ResolveContentOptions): Promise<void>;
  get(
    ref: ContentRef,
    options: ResolveContentOptions,
  ): Promise<ResolvedContent>;
  getMany(
    refs: readonly ContentRef[],
    options: ResolveContentOptions,
  ): Promise<readonly ResolvedContent[]>;
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

  const getMany: ContentResolver["getMany"] = async (refs, options) => {
    options.signal?.throwIfAborted();
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    ) {
      throw new TypeError("maxBytes must be a non-negative safe integer.");
    }
    for (const ref of refs) {
      options.signal?.throwIfAborted();
      await requireAuthorization(dependencies.authorize, ref, options);
    }
    options.signal?.throwIfAborted();
    const ids = [...new Set(refs.map((ref) => ref.assetId))];
    if (!ids.length) return ([] as const);
    if (options.maxBytes !== undefined) {
      const metadata = await dependencies.assets.getMany(
        options.namespace,
        ids,
      );
      options.signal?.throwIfAborted();
      if (
        metadata.length !== ids.length ||
        metadata.some((asset, index) =>
          asset.id !== ids[index] || asset.namespace !== options.namespace ||
          !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0
        )
      ) {
        throw createContentError(
          "asset_corrupted",
          "Asset repository returned an invalid metadata batch.",
          { namespace: options.namespace },
        );
      }
      const bytes = metadata.reduce((sum, asset) => sum + asset.byteLength, 0);
      if (bytes > options.maxBytes) {
        throw createContentByteLimitError(bytes, options.maxBytes);
      }
    }
    const bodies = await dependencies.assets.readMany(options.namespace, ids);
    options.signal?.throwIfAborted();
    if (bodies.length !== ids.length) {
      throw createContentError(
        "asset_corrupted",
        "Asset repository returned an incomplete content batch.",
        { namespace: options.namespace },
      );
    }
    const readers = new Map(
      await Promise.all(ids.map(async (id, index) => {
        // Identity and integrity are checked once for each unique body.
        return [
          id,
          await prepareBody(id, bodies[index], options.namespace, digest),
        ] as const;
      })),
    );
    const resolved = refs.map((ref) => readers.get(ref.assetId)!(ref));
    options.signal?.throwIfAborted();
    if (
      options.maxBytes !== undefined &&
      bodies.reduce((sum, body) => sum + body.bytes.byteLength, 0) >
        options.maxBytes
    ) {
      throw createContentByteLimitError(
        bodies.reduce((sum, body) => sum + body.bytes.byteLength, 0),
        options.maxBytes,
      );
    }
    return resolved;
  };

  const get: ContentResolver["get"] = async (ref, options) => {
    if (options.maxBytes !== undefined) {
      return (await getMany([ref], options))[0];
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
