import type { ScopedCollection } from "../collections/index.ts";
import type { BodyStore } from "../content/index.ts";
import {
  openProgressiveBodyFollower,
  type ProgressiveBodyFollower,
} from "../content/index.ts";
import { createContentError } from "../content/index.ts";

export type OpenStreamFollowerInput = Readonly<{
  streams: ScopedCollection;
  store: BodyStore;
  namespace: string;
  streamId: string;
  offset?: number;
}>;

export async function openStreamFollower(
  input: OpenStreamFollowerInput,
): Promise<ProgressiveBodyFollower> {
  const streamId = input.streamId.trim();
  const record = await input.streams.get({ id: streamId });
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
  const bodyId = typeof record.bodyId === "string" && record.bodyId.trim()
    ? record.bodyId.trim()
    : "";
  if (!bodyId) {
    throw createContentError(
      "content_invalid",
      "Stream record has no bodyId.",
    );
  }
  return await openProgressiveBodyFollower(input.store, {
    bodyId,
    offset: input.offset,
  });
}
