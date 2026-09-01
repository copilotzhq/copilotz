import { ulid } from "../../dependencies/ulid.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
  type ProgressiveBodyWriter,
} from "../content/progressive.ts";
import type { BodyStore, ReadyBodyHead } from "../content/body-store.ts";
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
  StreamCapture,
  StreamTerminalOutcome,
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
  StreamCapture,
  StreamTerminalOutcome,
} from "./types.ts";

/** Signals that a durable catalog no longer accepts writes from this lane. */
export class ContentStreamOwnershipLostError extends Error {
  readonly code = "content_stream_ownership_lost";

  constructor(streamId: string) {
    super(`Content stream '${streamId}' lost durable write ownership.`);
    this.name = "ContentStreamOwnershipLostError";
  }
}

function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}

function bodyLocation(
  store: BodyStore,
  head: ReadyBodyHead,
): AssetBodyLocation {
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
      ? `incarnation:${encodeURIComponent(semanticId)}:${
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
      let published = false;
      try {
        await options.onOpen?.(
          opened,
          Object.freeze({
            established() {
              published = true;
            },
          }),
        );
        if (!published) {
          throw new Error(
            "Content stream publication must be explicitly established.",
          );
        }
      } catch (error) {
        if (!published) {
          await body.abandon().catch(() => undefined);
          await Promise.resolve(options.onDiscard?.(opened)).catch(() =>
            undefined
          );
        } else {
          const termination = Object.freeze({
            outcome: "abandoned" as const,
            capture: "truncated" as const,
          });
          body.fence();
          await Promise.resolve(options.onTerminalizing?.(opened, termination))
            .catch(() => undefined);
          const incomplete = await body.terminate().catch(() => undefined);
          if (incomplete) {
            await Promise.resolve(
              options.onTerminate?.(opened, incomplete, termination),
            )
              .catch(() => undefined);
          }
        }
        throw error;
      }
      let terminalKind: "sealed" | "terminated" | undefined;
      let terminalTask: Promise<void> | undefined;
      let sealed = false;
      let readyBody:
        | Awaited<ReturnType<ProgressiveBodyWriter["finalize"]>>
        | undefined;
      let incompleteBody:
        | Awaited<ReturnType<ProgressiveBodyWriter["terminate"]>>
        | undefined;
      let physicalTerminationAttempted = false;
      let closeIdentity:
        | Readonly<{ assetId: string; input: ContentStreamCloseInput }>
        | undefined;
      let termination:
        | Readonly<{
          outcome: Exclude<StreamTerminalOutcome, "completed">;
          capture: StreamCapture;
        }>
        | undefined;
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
        if (terminalKind === "terminated") {
          throw new Error(`Content stream '${id}' is already settled.`);
        }
        const assetId = closeInput.assetId.trim();
        if (!assetId) {
          throw new TypeError("Content stream assetId is required.");
        }
        if (closeIdentity && closeIdentity.assetId !== assetId) {
          throw new Error(
            `Content stream '${id}' was already closed with another Asset identity.`,
          );
        }
        closeIdentity ??= Object.freeze({ assetId, input: closeInput });
        terminalKind = "sealed";
        terminalTask ??= (async () => {
          body.fence();
          await options.onTerminalizing?.(opened, {
            outcome: "completed",
            capture: "complete",
          });
          readyBody ??= await body.finalize();
          await options.onSeal?.(opened, readyBody);
          sealed = true;
          removeLifetimeAbort();
        })().catch((error) => {
          // Physical settlement is immutable, but a failed catalog callback is
          // retryable by invoking the same terminal operation again.
          terminalTask = undefined;
          throw error;
        });
        await terminalTask;
        throwIfAborted(closeOptions.signal);
        const finalBody = readyBody!;
        const ref = contentRef(assetId);
        return Object.freeze({
          content: Object.freeze([ref]),
          assets: Object.freeze([Object.freeze({
            id: assetId,
            namespace,
            mediaType,
            body: new Uint8Array(),
            readyBody: finalBody,
            location: bodyLocation(options.store, finalBody),
            byteLength: finalBody.byteLength,
            digest: finalBody.digest,
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
        abortInput: ContentStreamAbortInput = {},
        abortOptions: { signal?: AbortSignal } = {},
      ): Promise<void> => {
        throwIfAborted(abortOptions.signal);
        if (terminalKind === "sealed") return;
        const normalized = Object.freeze({
          outcome: abortInput.outcome ?? "failed",
          capture: abortInput.capture ?? "truncated",
        });
        if (
          termination &&
          (termination.outcome !== normalized.outcome ||
            termination.capture !== normalized.capture)
        ) {
          throw new Error(
            `Content stream '${id}' is already terminating with another outcome.`,
          );
        }
        termination ??= normalized;
        terminalKind = "terminated";
        terminalTask ??= (async () => {
          body.fence();
          await options.onTerminalizing?.(opened, termination!);
          if (!physicalTerminationAttempted) {
            incompleteBody = await body.terminate();
            physicalTerminationAttempted = true;
          }
          await options.onTerminate?.(
            opened,
            incompleteBody!,
            termination!,
          );
          removeLifetimeAbort();
        })().catch((error) => {
          terminalTask = undefined;
          throw error;
        });
        await terminalTask;
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
            : Object.freeze({ retention: "observation" });
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
          if (terminalKind) {
            throw new Error(`Content stream '${id}' is already settling.`);
          }
          const result = await body.append(appendInput);
          const appended = Object.freeze({
            startOffset: result.startOffset,
            endOffset: result.endOffset,
          });
          try {
            await options.onAppend?.(opened, appended);
          } catch (error) {
            if (error instanceof ContentStreamOwnershipLostError) {
              // The raced append may already be visible to live followers, so
              // freeze immediately and let terminalization publish the exact
              // immutable Body length as the replay boundary.
              await abort({ outcome: "superseded", capture: "truncated" })
                .catch(() => undefined);
            }
            throw error;
          }
          return appended;
        },
        close,
        abort,
        retain,
        async [Symbol.asyncDispose]() {
          await abort({
            reason: "Content stream writer disposed.",
            outcome: "abandoned",
          });
        },
      });
      if (options.signal) {
        const lifetimeAbort = () => {
          // Execution signals also end after successful Processor completion.
          // Give explicit cleanup (for example abort({outcome:'cancelled'}))
          // one task to record the real outcome; only a leaked writer falls
          // back to the generic abandoned terminal state.
          setTimeout(() => {
            void abort({
              reason: "Content stream execution ended.",
              outcome: "abandoned",
            }).catch(() => undefined);
          }, 0);
        };
        removeLifetimeAbort = () =>
          options.signal?.removeEventListener("abort", lifetimeAbort);
        if (options.signal.aborted) lifetimeAbort();
        else {
          options.signal.addEventListener("abort", lifetimeAbort, {
            once: true,
          });
        }
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
