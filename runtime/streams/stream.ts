import { ulid } from "../../dependencies/ulid.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
  type ProgressiveBodyWriter,
} from "../content/progressive.ts";
import type { BodyHead, BodyStore } from "../content/body-store.ts";
import type {
  AssetBodyLocation,
  ContentKind,
  ContentRef,
  PreparedContent,
} from "../content/types.ts";
import type {
  ContentStreamAbortInput,
  ContentStreamAppendInput,
  ContentStreamCloseInput,
  ContentStreamRetentionInput,
  ContentStreamRuntime,
  CreateContentStreamRuntimeOptions,
} from "./types.ts";
import { snapshotStreamMetadata } from "./json.ts";
export type {
  ContentStreamAbortInput,
  ContentStreamAppendInput,
  ContentStreamAppendResult,
  ContentStreamCloseInput,
  ContentStreamFollowInput,
  ContentStreamOpened,
  ContentStreamOpenInput,
  ContentStreamRetentionInput,
  ContentStreamRuntime,
  ContentStreamWriter,
  CreateContentStreamRuntimeOptions,
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
  input: Readonly<{
    namespace: string;
    streamId: string;
    bodyPrefix?: string;
  }>,
): string {
  const namespace = input.namespace.trim();
  const streamId = input.streamId.trim();
  if (!namespace || !streamId) {
    throw new TypeError(
      "Content stream body id requires namespace and stream id.",
    );
  }
  return [
    ...(input.bodyPrefix?.split("/").map((part) => part.trim()).filter(
      Boolean,
    ) ?? []),
    "content-streams",
    cleanSegment(namespace),
    cleanSegment(streamId),
  ].join("/");
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

export function createContentStreamRuntime(
  options: CreateContentStreamRuntimeOptions,
): ContentStreamRuntime {
  const namespace = options.namespace.trim();
  if (!namespace) throw new TypeError("Content stream namespace is required.");
  const createId = options.createId ?? ulid;
  const incarnationId = options.incarnationId?.trim() || undefined;

  // Encoding both parts makes the composite injective even when a caller's
  // semantic ID contains our separators. A recovered execution consequently
  // gets a fresh physical Body/catalog lane instead of reopening or appending
  // to bytes produced by a previous provider invocation.
  const physicalId = (semanticId: string): string =>
    incarnationId
      ? `incarnation.v1:${encodeURIComponent(semanticId)}:${
        encodeURIComponent(incarnationId)
      }`
      : semanticId;

  return Object.freeze({
    async open(input, openOptions = {}) {
      throwIfAborted(openOptions.signal);
      const semanticId = input.id?.trim() || createId();
      const id = physicalId(semanticId);
      const mediaType = input.mediaType.trim();
      const role = input.role.trim();
      if (!semanticId || !id || !mediaType || !role) {
        throw new TypeError("Content stream requires id, mediaType, and role.");
      }
      const kind = input.kind ?? mediaKind(mediaType);
      const name = input.name?.trim();
      const alt = input.alt?.trim();
      const language = input.language?.trim();
      const correlationId = input.correlationId?.trim();
      const metadata = snapshotStreamMetadata(input.metadata ?? {});
      const bodyId = contentStreamBodyId({
        namespace,
        streamId: id,
        bodyPrefix: options.bodyPrefix,
      });
      const body: ProgressiveBodyWriter = await createProgressiveBodyWriter(
        options.store,
        { bodyId, mediaType },
      );
      const opened = Object.freeze({
        id,
        semanticId,
        ...(incarnationId ? { incarnationId } : {}),
        mediaType,
        kind,
        role,
        ...(name ? { name } : {}),
        ...(alt ? { alt } : {}),
        ...(language ? { language } : {}),
        ...(input.disposition ? { disposition: input.disposition } : {}),
        metadata,
        ...(correlationId ? { correlationId } : {}),
      });
      try {
        await options.onOpen?.(opened);
      } catch (error) {
        await body.abandon().catch(() => undefined);
        await Promise.resolve(options.onAbort?.(opened)).catch(() => undefined);
        throw error;
      }
      let settled = false;
      let sealed = false;
      let removeLifetimeAbort = () => {};

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
          ...(input.metadata
            ? { metadata: metadata as Record<string, unknown> }
            : {}),
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
        await options.onSeal?.(opened, readyBody);
        settled = true;
        sealed = true;
        removeLifetimeAbort();
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
              ...metadata,
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
        removeLifetimeAbort();
        await body.abandon();
        await options.onAbort?.(opened);
      };

      const retain = async (
        retentionInput: ContentStreamRetentionInput,
        bindOptions: { signal?: AbortSignal } = {},
      ): Promise<void> => {
        throwIfAborted(bindOptions.signal);
        if (!sealed) {
          throw new Error(
            `Content stream '${id}' must be sealed before Asset binding.`,
          );
        }
        const normalized: ContentStreamRetentionInput =
          retentionInput.retention === "canonical"
            ? Object.freeze({
              retention: "canonical",
              assetId: retentionInput.assetId.trim(),
            })
            : Object.freeze({
              retention: "observation",
              expiresAt: new Date(retentionInput.expiresAt).toISOString(),
            });
        if (normalized.retention === "canonical" && !normalized.assetId) {
          throw new TypeError("Canonical stream retention requires assetId.");
        }
        await options.onRetain?.(opened, normalized);
      };

      const writer = Object.freeze({
        id,
        offset: () => body.offset(),
        async append(
          appendInput: ContentStreamAppendInput,
          appendOptions: { signal?: AbortSignal } = {},
        ) {
          throwIfAborted(appendOptions.signal);
          const result = await body.append(appendInput);
          const appended = Object.freeze({
            startOffset: result.startOffset,
            endOffset: result.endOffset,
          });
          await options.onAppend?.(opened, appended);
          return appended;
        },
        close,
        abort,
        retain,
        async [Symbol.asyncDispose]() {
          await abort({ reason: "Content stream writer disposed." });
        },
      });
      if (options.signal) {
        const lifetimeAbort = () => {
          void abort({ reason: "Content stream execution ended." }).catch(
            () => undefined,
          );
        };
        removeLifetimeAbort = () =>
          options.signal?.removeEventListener("abort", lifetimeAbort);
        if (options.signal.aborted) lifetimeAbort();
        else {options.signal.addEventListener("abort", lifetimeAbort, {
            once: true,
          });}
      }
      return writer;
    },
    async follow(input, followOptions = {}) {
      throwIfAborted(followOptions.signal);
      const streamId = input.id.trim();
      if (!streamId) throw new TypeError("Content stream id is required.");
      return await openProgressiveBodyFollower(options.store, {
        bodyId: contentStreamBodyId({
          namespace,
          streamId,
          bodyPrefix: options.bodyPrefix,
        }),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      });
    },
  });
}
