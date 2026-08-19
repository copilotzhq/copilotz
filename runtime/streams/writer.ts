import { ulid } from "../../dependencies/ulid.ts";
import type {
  BoundCollection,
  CollectionMutation,
  CollectionMutationIdentity,
  CollectionRecord,
} from "../collections/index.ts";
import type { EventRouting, EventVisibility } from "../events/index.ts";
import type {
  AssetBodyHead,
  AssetBodyStore,
  ContentRef,
} from "../content/index.ts";
import {
  createProgressiveBodyWriter,
  type ProgressiveBodyWriter,
} from "../content/index.ts";
import {
  contentKindFromMediaType,
  contentRoleForLane,
  streamBodyKey,
} from "./keys.ts";

export type StreamWriter = Readonly<{
  id: string;
  assetId: string;
  key: string;
  offset(): number;
  discarded(): number;
  created: CollectionMutation<CollectionRecord>;
  write(chunk: Uint8Array): Promise<void>;
  retain(byteLength?: number): Promise<AssetBodyHead>;
  discard(byteLength?: number): Promise<void>;
  finalize(): Promise<AssetBodyHead>;
  abandon(reason?: string): Promise<void>;
  fail(message: string, code?: string): Promise<void>;
}>;

export type CreateStreamWriterInput = Readonly<{
  streams: BoundCollection;
  store: AssetBodyStore;
  namespace: string;
  threadId: string;
  lane: string;
  mediaType: string;
  participantId?: string;
  id?: string;
  assetId?: string;
  metadata?: Record<string, unknown>;
  identity?: CollectionMutationIdentity;
  routing?: EventRouting;
  visibility?: EventVisibility;
  createId?: () => string;
}>;

export async function createStreamWriter(
  input: CreateStreamWriterInput,
): Promise<StreamWriter> {
  const namespace = input.namespace.trim();
  const threadId = input.threadId.trim();
  const lane = input.lane.trim();
  const mediaType = input.mediaType.trim();
  if (!namespace || !threadId || !lane || !mediaType) {
    throw new TypeError(
      "Stream writer requires namespace, threadId, lane, and mediaType.",
    );
  }
  const createId = input.createId ?? ulid;
  const id = input.id?.trim() || createId();
  const assetId = input.assetId?.trim() || createId();
  const key = streamBodyKey({ namespace, assetId });
  const content: ContentRef[] = [Object.freeze({
    assetId,
    kind: contentKindFromMediaType(mediaType),
    role: contentRoleForLane(lane),
    mediaType,
  })];
  const body: ProgressiveBodyWriter = await createProgressiveBodyWriter(
    input.store,
    { key, mediaType },
  );
  let created: CollectionMutation<CollectionRecord>;
  try {
    created = await input.streams.create({
      id,
      threadId,
      lane,
      mediaType,
      content,
      ...(input.participantId?.trim()
        ? { participantId: input.participantId.trim() }
        : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }, {
      namespace,
      threadId,
      ...(input.identity ? { identity: input.identity } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    });
  } catch (error) {
    await body.abandon().catch(() => undefined);
    throw error;
  }

  const close = (command: "close" | "fail" | "abandon", payload: unknown) =>
    input.streams.mutate(id, command, payload, { namespace, threadId });

  return Object.freeze({
    id,
    assetId,
    key,
    offset: () => body.offset(),
    discarded: () => body.discarded(),
    created,
    write: (chunk) => body.write(chunk),
    async retain(byteLength) {
      const head = await body.retain(byteLength);
      await close("close", { content });
      return head;
    },
    discard: (byteLength) => body.discard(byteLength),
    async finalize() {
      const head = await body.finalize();
      await close("close", { content });
      return head;
    },
    async abandon(reason) {
      await body.abandon();
      await close("abandon", reason ? { reason } : {});
    },
    async fail(message, code) {
      await body.abandon();
      await close("fail", { message, ...(code ? { code } : {}) });
    },
  });
}
