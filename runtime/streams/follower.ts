import type { BoundCollection } from "../collections/index.ts";
import type { AssetBodyStore } from "../content/index.ts";
import {
  openProgressiveBodyFollower,
  type ProgressiveBodyFollower,
} from "../content/index.ts";
import { createContentError } from "../content/index.ts";
import { streamBodyKey } from "./keys.ts";

export type OpenStreamFollowerInput = Readonly<{
  streams: BoundCollection;
  store: AssetBodyStore;
  namespace: string;
  streamId: string;
  offset?: number;
}>;

function contentAssetId(record: Record<string, unknown>): string {
  const content = record.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw createContentError(
      "content_invalid",
      "Stream record has no content reference.",
    );
  }
  const assetId = (content[0] as { assetId?: unknown }).assetId;
  if (typeof assetId !== "string" || !assetId.trim()) {
    throw createContentError(
      "content_invalid",
      "Stream content reference is missing assetId.",
    );
  }
  return assetId.trim();
}

export async function openStreamFollower(
  input: OpenStreamFollowerInput,
): Promise<ProgressiveBodyFollower> {
  const namespace = input.namespace.trim();
  const streamId = input.streamId.trim();
  const record = await input.streams.get(streamId, namespace);
  if (!record) {
    throw createContentError(
      "asset_not_found",
      `Stream was not found: ${streamId}`,
    );
  }
  if (record.state === "abandoned") {
    throw createContentError(
      "asset_deleted",
      "Stream was abandoned.",
    );
  }
  const key = streamBodyKey({
    namespace,
    assetId: contentAssetId(record),
  });
  return await openProgressiveBodyFollower(input.store, {
    key,
    offset: input.offset,
  });
}
