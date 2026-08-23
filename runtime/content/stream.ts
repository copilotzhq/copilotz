import { ulid } from "../../dependencies/ulid.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
  type ProgressiveBodyFollower,
  type ProgressiveBodyWriter,
} from "./progressive.ts";
import type { BodyHead, BodyStore } from "./body-store.ts";
import type {
  AssetBodyLocation,
  AssetOrigin,
  ContentKind,
  ContentRef,
  ContentRole,
  PreparedContent,
} from "./types.ts";

function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}

function bodyLocation(store: BodyStore, head: BodyHead): AssetBodyLocation {
  if (store.kind === "object") {
    return {
      kind: "object",
      backendId: store.backendId,
      key: head.bodyId,
      ...(head.etag ? { etag: head.etag } : {}),
    };
  }
  if (store.kind === "filesystem") {
    return { kind: "filesystem", backendId: store.backendId, key: head.bodyId };
  }
  if (store.kind === "database") return { kind: "database", key: head.bodyId };
  return { kind: "memory", backendId: store.backendId, key: head.bodyId };
}

function contentStreamBodyId(
  input: Readonly<{ namespace: string; streamId: string }>,
): string {
  const namespace = input.namespace.trim();
  const streamId = input.streamId.trim();
  if (!namespace || !streamId) {
    throw new TypeError(
      "Content stream body id requires namespace and stream id.",
    );
  }
  return ["content-streams", cleanSegment(namespace), cleanSegment(streamId)]
    .join("/");
}

function mediaKind(mediaType: string): ContentKind {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "application/json" || normalized.endsWith("+json")) {
    return "json";
  }
  if (normalized.startsWith("text/")) return "text";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "file";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation was aborted.", "AbortError");
}

export type ContentStreamOpenInput = Readonly<{
  id?: string;
  mediaType: string;
  kind?: ContentKind;
  role: ContentRole | string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Readonly<Record<string, unknown>>;
  correlationId?: string;
}>;

export type ContentStreamOpened = Readonly<{
  id: string;
  mediaType: string;
  kind: ContentKind;
  role: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata: Readonly<Record<string, unknown>>;
  correlationId?: string;
}>;

export type ContentStreamAppendInput = Readonly<{
  bytes: Uint8Array;
  appendId: string;
}>;

export type ContentStreamAppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
}>;

export type ContentStreamCloseInput = Readonly<{
  assetId: string;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ContentStreamAbortInput = Readonly<{
  reason?: string;
}>;

export type ContentStreamFollowInput = Readonly<{
  id: string;
  offset?: number;
}>;

export type ContentStreamWriter = Readonly<
  & AsyncDisposable
  & {
    readonly id: string;
    offset(): number;
    append(
      input: ContentStreamAppendInput,
      options?: { signal?: AbortSignal },
    ): Promise<ContentStreamAppendResult>;
    close(
      input: ContentStreamCloseInput,
      options?: { signal?: AbortSignal },
    ): Promise<PreparedContent>;
    abort(
      input?: ContentStreamAbortInput,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  }
>;

export type ContentStreamRuntime = Readonly<{
  open(
    input: ContentStreamOpenInput,
    options?: { signal?: AbortSignal },
  ): Promise<ContentStreamWriter>;
  follow(
    input: ContentStreamFollowInput,
    options?: { signal?: AbortSignal },
  ): Promise<ProgressiveBodyFollower>;
}>;

export type CreateContentStreamRuntimeOptions = Readonly<{
  namespace: string;
  store: BodyStore;
  createId?: () => string;
  onOpen?(input: ContentStreamOpened): void | Promise<void>;
}>;

export function createContentStreamRuntime(
  options: CreateContentStreamRuntimeOptions,
): ContentStreamRuntime {
  const namespace = options.namespace.trim();
  if (!namespace) throw new TypeError("Content stream namespace is required.");
  const createId = options.createId ?? ulid;

  return Object.freeze({
    async open(input, openOptions = {}) {
      throwIfAborted(openOptions.signal);
      const id = input.id?.trim() || createId();
      const mediaType = input.mediaType.trim();
      const role = input.role.trim();
      if (!id || !mediaType || !role) {
        throw new TypeError("Content stream requires id, mediaType, and role.");
      }
      const kind = input.kind ?? mediaKind(mediaType);
      const name = input.name?.trim();
      const alt = input.alt?.trim();
      const language = input.language?.trim();
      const correlationId = input.correlationId?.trim();
      const metadata = Object.freeze(structuredClone(input.metadata ?? {}));
      const bodyId = contentStreamBodyId({ namespace, streamId: id });
      const body: ProgressiveBodyWriter = await createProgressiveBodyWriter(
        options.store,
        { bodyId, mediaType },
      );
      await options.onOpen?.(Object.freeze({
        id,
        mediaType,
        kind,
        role,
        ...(name ? { name } : {}),
        ...(alt ? { alt } : {}),
        ...(language ? { language } : {}),
        ...(input.disposition ? { disposition: input.disposition } : {}),
        metadata,
        ...(correlationId ? { correlationId } : {}),
      }));
      let settled = false;

      const contentRef = (assetId: string): ContentRef =>
        Object.freeze({
          assetId,
          kind,
          role,
          mediaType,
          ...(name ? { name } : {}),
          ...(alt ? { alt } : {}),
          ...(language ? { language } : {}),
          ...(input.disposition ? { disposition: input.disposition } : {}),
          ...(input.metadata ? { metadata: structuredClone(metadata) } : {}),
        });

      const close = async (
        closeInput: ContentStreamCloseInput,
        closeOptions: { signal?: AbortSignal } = {},
      ): Promise<PreparedContent> => {
        throwIfAborted(closeOptions.signal);
        if (settled) {
          throw new Error(`Content stream '${id}' is already settled.`);
        }
        const assetId = closeInput.assetId.trim();
        if (!assetId) {
          throw new TypeError("Content stream assetId is required.");
        }
        const readyBody = await body.finalize();
        throwIfAborted(closeOptions.signal);
        settled = true;
        const ref = contentRef(assetId);
        return Object.freeze({
          content: Object.freeze([ref]),
          assets: Object.freeze([Object.freeze({
            id: assetId,
            namespace,
            mediaType,
            body: new Uint8Array(),
            readyBody,
            location: bodyLocation(options.store, readyBody),
            byteLength: readyBody.byteLength,
            digest: readyBody.digest,
            idempotencyKey:
              `${namespace}:content-stream:${id}:asset:${assetId}`,
            ...(closeInput.origin
              ? { origin: structuredClone(closeInput.origin) }
              : {}),
            metadata: {
              ...(input.metadata ? structuredClone(input.metadata) : {}),
              ...(closeInput.metadata
                ? structuredClone(closeInput.metadata)
                : {}),
              streamId: id,
            },
          })]),
        });
      };

      const abort = async (
        _input: ContentStreamAbortInput = {},
        abortOptions: { signal?: AbortSignal } = {},
      ): Promise<void> => {
        throwIfAborted(abortOptions.signal);
        if (settled) return;
        settled = true;
        await body.abandon();
      };

      return Object.freeze({
        id,
        offset: () => body.offset(),
        async append(
          appendInput: ContentStreamAppendInput,
          appendOptions: { signal?: AbortSignal } = {},
        ) {
          throwIfAborted(appendOptions.signal);
          const result = await body.append(appendInput);
          return Object.freeze({
            startOffset: result.startOffset,
            endOffset: result.endOffset,
          });
        },
        close,
        abort,
        async [Symbol.asyncDispose]() {
          await abort({ reason: "Content stream writer disposed." });
        },
      });
    },
    async follow(input, followOptions = {}) {
      throwIfAborted(followOptions.signal);
      const streamId = input.id.trim();
      if (!streamId) throw new TypeError("Content stream id is required.");
      return await openProgressiveBodyFollower(options.store, {
        bodyId: contentStreamBodyId({ namespace, streamId }),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      });
    },
  });
}
