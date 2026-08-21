import { ulid } from "../../dependencies/ulid.ts";
import type {
  CollectionMutationIdentity,
  CollectionRecord,
  ScopedCollection,
} from "../collections/index.ts";
import type { EventRouting, EventVisibility } from "../events/index.ts";
import type { BodyHead, BodyStore, ContentRef } from "../content/index.ts";
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
  offset(): number;
  created: CollectionRecord;
  write(chunk: Uint8Array): Promise<void>;
  finalize(): Promise<BodyHead>;
  abandon(reason?: string): Promise<void>;
  fail(message: string, code?: string): Promise<void>;
}>;

export type CreateStreamWriterInput = Readonly<{
  streams: ScopedCollection;
  store: BodyStore;
  namespace: string;
  threadId: string;
  lane: string;
  mediaType: string;
  participantId?: string;
  id?: string;
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
  const assetId = createId();
  const bodyId = streamBodyKey({ namespace, assetId });
  const content: ContentRef[] = [Object.freeze({
    assetId,
    kind: contentKindFromMediaType(mediaType),
    role: contentRoleForLane(lane),
    mediaType,
  })];
  const body: ProgressiveBodyWriter = await createProgressiveBodyWriter(
    input.store,
    { bodyId, mediaType },
  );
  let created: CollectionRecord;
  try {
    created = await input.streams.create({
      id,
      threadId,
      lane,
      mediaType,
      bodyId,
      content,
      ...(input.participantId?.trim()
        ? { participantId: input.participantId.trim() }
        : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }, {
      threadId,
      ...(input.identity ? { identity: input.identity } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    });
  } catch (error) {
    await body.abandon().catch(() => undefined);
    throw error;
  }

  const close = (
    command: "close" | "fail" | "abandon",
    payload: unknown,
  ) => {
    const invoke = input.streams.commands[command];
    if (!invoke) throw new Error(`Stream command '${command}' is not bound.`);
    return invoke({ id, ...payload as Record<string, unknown> }, { threadId });
  };

  return Object.freeze({
    id,
    offset: () => body.offset(),
    created,
    write: (chunk) => body.write(chunk),
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
