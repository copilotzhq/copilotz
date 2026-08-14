import { createContentError } from "./errors.ts";
import {
  cloneContentRef,
  materializeContentInput,
  withoutUndefined,
} from "./input.ts";
import type {
  AssetRepository,
  ContentInput,
  ContentRef,
  ContentSequence,
  NormalizeContentOptions,
} from "./types.ts";

export type ContentNormalizer = {
  normalize(
    input: ContentInput | readonly ContentInput[],
    options: NormalizeContentOptions,
  ): Promise<ContentSequence>;
};

/** Converts boundary content into one ordered sequence of immutable refs. */
export function createContentNormalizer(
  dependencies: { assets: AssetRepository },
): ContentNormalizer {
  return {
    normalize(input, options) {
      return materializeContentInput(input, options, {
        async materialize(candidate) {
          const asset = await dependencies.assets.publish({
            namespace: options.namespace,
            mediaType: candidate.mediaType,
            body: candidate.body,
            idempotencyKey: candidate.idempotencyKey,
            origin: candidate.origin,
            metadata: candidate.fields.metadata,
          });
          return withoutUndefined({
            assetId: asset.id,
            kind: candidate.kind,
            role: candidate.role,
            mediaType: asset.mediaType,
            ...candidate.fields,
          }) as ContentRef;
        },
        async reference(ref) {
          const asset = await dependencies.assets.get(
            options.namespace,
            ref.assetId,
          );
          if (!asset) {
            throw createContentError(
              "asset_not_found",
              `Referenced asset was not found: ${ref.assetId}`,
              { namespace: options.namespace, assetId: ref.assetId },
            );
          }
          if (asset.state === "deleted") {
            throw createContentError(
              "asset_deleted",
              `Referenced asset has been deleted: ${ref.assetId}`,
              { namespace: options.namespace, assetId: ref.assetId },
            );
          }
          if (asset.state !== "ready") {
            throw createContentError(
              "asset_not_ready",
              `Referenced asset is not ready: ${ref.assetId}`,
              { namespace: options.namespace, assetId: ref.assetId },
            );
          }
          if (asset.mediaType !== ref.mediaType) {
            throw createContentError(
              "asset_conflict",
              `Referenced asset media type does not match: ${ref.assetId}`,
              { namespace: options.namespace, assetId: ref.assetId },
            );
          }
          return cloneContentRef(ref);
        },
      });
    },
  };
}
