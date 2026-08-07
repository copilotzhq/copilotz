import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import type {
  AssetBody,
  AssetRepository,
  AuthorizeContent,
  ContentRef,
  ResolveContentOptions,
  ResolvedContent,
} from "./types.ts";

export type ContentResolver = {
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

async function resolveBody(
  ref: ContentRef,
  body: AssetBody,
  namespace: string,
  digest: (bytes: Uint8Array) => Promise<`sha256:${string}`>,
): Promise<ResolvedContent> {
  const { asset } = body;
  if (asset.id !== ref.assetId || asset.namespace !== namespace) {
    throw createContentError(
      "asset_corrupted",
      `Asset repository returned the wrong body for: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }
  if (asset.state === "deleted") {
    throw createContentError(
      "asset_deleted",
      `Asset has been deleted: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }
  if (asset.state !== "ready") {
    throw createContentError(
      "asset_not_ready",
      `Asset is not ready: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }
  if (asset.mediaType !== ref.mediaType) {
    throw createContentError(
      "asset_corrupted",
      `Asset media type does not match its content reference: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }
  if (asset.byteLength !== body.bytes.byteLength) {
    throw createContentError(
      "asset_corrupted",
      `Asset byte length does not match its body: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }
  if (await digest(body.bytes) !== asset.digest) {
    throw createContentError(
      "asset_corrupted",
      `Asset digest does not match its body: ${ref.assetId}`,
      { namespace, assetId: ref.assetId },
    );
  }

  const resolved: ResolvedContent = {
    ref: {
      ...ref,
      metadata: ref.metadata === undefined
        ? undefined
        : structuredClone(ref.metadata),
    },
    asset: {
      ...asset,
      location: { ...asset.location },
      metadata: asset.metadata === undefined
        ? undefined
        : structuredClone(asset.metadata),
    },
    bytes: body.bytes.slice(),
  };

  if (ref.kind === "text") {
    resolved.text = new TextDecoder().decode(body.bytes);
  } else if (ref.kind === "json") {
    const text = new TextDecoder().decode(body.bytes);
    resolved.text = text;
    try {
      resolved.value = JSON.parse(text);
    } catch (cause) {
      throw createContentError(
        "asset_corrupted",
        `JSON asset body cannot be decoded: ${ref.assetId}`,
        { namespace, assetId: ref.assetId, cause },
      );
    }
  }

  return resolved;
}

/** Creates an authorization-aware, integrity-checking content resolver. */
export function createContentResolver(dependencies: {
  assets: AssetRepository;
  authorize?: AuthorizeContent;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
}): ContentResolver {
  const digest = dependencies.digest ?? digestContent;

  const get: ContentResolver["get"] = async (ref, options) => {
    await requireAuthorization(dependencies.authorize, ref, options);
    const body = await dependencies.assets.read(
      options.namespace,
      ref.assetId,
    );
    return await resolveBody(ref, body, options.namespace, digest);
  };

  const getMany: ContentResolver["getMany"] = async (refs, options) => {
    await Promise.all(
      refs.map((ref) =>
        requireAuthorization(dependencies.authorize, ref, options)
      ),
    );
    const bodies = await dependencies.assets.readMany(
      options.namespace,
      refs.map((ref) => ref.assetId),
    );
    if (bodies.length !== refs.length) {
      throw createContentError(
        "asset_corrupted",
        "Asset repository returned an incomplete content batch.",
        { namespace: options.namespace },
      );
    }
    return await Promise.all(
      refs.map((ref, index) =>
        resolveBody(ref, bodies[index], options.namespace, digest)
      ),
    );
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

  return { get, getMany, open };
}
