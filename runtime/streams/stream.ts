import {
  promoteConfiguredLogicalBody,
  promotedReadyStore,
} from "../content/promoted-body-store.ts";
import { digestContent } from "../content/digest.ts";
import { digestCatalogPrefix } from "../content/prefix-digest.ts";
import { ulid } from "../../dependencies/ulid.ts";
import { createContentError } from "../content/errors.ts";
import {
  CONTENT_CHUNK_BYTES,
  CONTENT_PROTECTION_MS,
  CONTENT_REPLAY_RETENTION_MS,
  type ContentWriter,
} from "../content/catalog.ts";
import { capturePendingContentDescriptor } from "../content/schema.ts";
import type { WriterCapability } from "../content/body-store.ts";
import type { ContentKind, PendingContentRef } from "../content/types.ts";
import type {
  ContentStreamAbortInput,
  ContentStreamCloseInput,
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
  StreamTerminalOutcome,
} from "./types.ts";

export class ContentStreamOwnershipLostError extends Error {
  readonly code = "content_stream_ownership_lost";
  constructor(streamId: string) {
    super(`Content stream '${streamId}' lost durable write ownership.`);
    this.name = "ContentStreamOwnershipLostError";
  }
}
function cleanSegment(value: string) {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}
function bodyIdFor(namespace: string, id: string, prefix?: string) {
  return [
    ...(prefix?.split("/").map((s) => s.trim()).filter(Boolean) ?? []),
    "content-streams",
    cleanSegment(namespace),
    cleanSegment(id),
  ].join("/");
}
function mediaKind(mediaType: string): ContentKind {
  const type = mediaType.toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) return "json";
  for (const kind of ["text", "image", "audio", "video"] as const) {
    if (type.startsWith(`${kind}/`)) return kind;
  }
  return "file";
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Operation was aborted.", "AbortError");
  }
}
function unref(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer !== "number") {
    (timer as unknown as { unref?(): void }).unref?.();
  } else {(globalThis as unknown as {
      Deno?: { unrefTimer?(id: number): void };
    }).Deno?.unrefTimer?.(timer);}
}

/** Catalog acceptance is the only lifecycle. The adapter stores physical bytes. */
export function createContentStreamRuntime(
  options: CreateContentStreamRuntimeOptions,
): ContentStreamRuntime {
  const namespace = options.namespace.trim();
  if (!namespace) throw new TypeError("Content stream namespace is required.");
  const catalog = options.catalog, store = options.store;
  const ready = promotedReadyStore(store);
  const resolveStore = options.storeForCopy ??
    ((copy) => copy.backendId === ready?.backendId ? ready! : store);
  const interval = options.checkpointIntervalMs ?? 1000;
  const protectionMs = options.protectionMs ?? CONTENT_PROTECTION_MS;
  if (!Number.isSafeInteger(protectionMs) || protectionMs < 2) {
    throw new TypeError("Invalid catalog protection duration.");
  }
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new TypeError("Checkpoint interval must be positive.");
  }
  return {
    async open(input, openOptions = {}) {
      cancelled(openOptions.signal);
      cancelled(options.signal);
      const semanticId = input.id?.trim() || (options.createId ?? ulid)();
      const incarnation = options.incarnationId?.trim();
      const id = incarnation
        ? `incarnation:${encodeURIComponent(semanticId)}:${
          encodeURIComponent(incarnation)
        }`
        : semanticId;
      const mediaType = input.mediaType.trim(), role = input.role.trim();
      if (!id || !mediaType || !role) {
        throw new TypeError("Content stream requires id, mediaType, and role.");
      }
      const kind = input.kind ?? mediaKind(mediaType),
        metadata = snapshotStreamMetadata(input.metadata ?? {});
      const opened = {
        id,
        semanticId,
        ...(incarnation ? { incarnationId: incarnation } : {}),
        mediaType,
        role,
        kind,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.alt?.trim() ? { alt: input.alt.trim() } : {}),
        ...(input.language?.trim() ? { language: input.language.trim() } : {}),
        ...(input.disposition ? { disposition: input.disposition } : {}),
        ...(input.correlationId?.trim()
          ? { correlationId: input.correlationId.trim() }
          : {}),
        metadata,
      };
      const bodyId = bodyIdFor(namespace, id, options.bodyPrefix);
      const identity: ContentWriter = {
        bodyId,
        writerId: incarnation ?? crypto.randomUUID(),
        generation: 1,
      };
      // Persist reservation before storage I/O or public descriptor publication.
      const logical = await catalog.reserve({
        ...identity,
        namespace,
        protectForMs: protectionMs,
        copy: {
          key: bodyId,
          backendKind: store.kind,
          backendId: store.backendId,
          collectable: store.conditionalDelete,
        },
      });
      let writer: WriterCapability = await store.reserve({
        bodyId: logical.copy.key,
        mediaType,
        reservationId: identity.writerId,
        generation: identity.generation,
      });
      let offset = writer.byteLength, committed = logical.committedOffset;
      let stopped = false,
        closed: PendingContentRef | undefined,
        terminalTask: Promise<void> | undefined;
      let failure: unknown;
      let tail: Promise<void> = Promise.resolve();
      let checkpointTimer: ReturnType<typeof setTimeout> | undefined,
        renewTimer: ReturnType<typeof setTimeout> | undefined;
      let lastCheckpoint = 0;
      let published = false;
      let removeAbort = () => {};
      const appends = new Map<
        string,
        { digest: string; startOffset: number; endOffset: number }
      >();
      const queue = <T>(run: () => Promise<T>): Promise<T> => {
        const result = tail.then(run);
        tail = result.then(() => undefined, () => undefined);
        return result;
      };
      const clearTimers = () => {
        if (checkpointTimer !== undefined) clearTimeout(checkpointTimer);
        if (renewTimer !== undefined) clearTimeout(renewTimer);
        checkpointTimer = renewTimer = undefined;
      };
      const checkpoint = async () => {
        if (offset === committed) return;
        const expectedOffset = committed, next = offset;
        committed = await catalog.checkpoint({
          ...identity,
          expectedOffset,
          offset: next,
        });
        lastCheckpoint = Date.now();
        await options.onAppend?.(opened, {
          startOffset: expectedOffset,
          endOffset: committed,
        });
      };
      const abort = async (
        abortInput: ContentStreamAbortInput = {},
        abortOptions: { signal?: AbortSignal } = {},
      ) => {
        cancelled(abortOptions.signal);
        if (closed) return;
        stopped = true;
        clearTimers();
        terminalTask ??= queue(async () => {
          const terminal = {
            outcome: abortInput.outcome ?? "failed" as const,
            ...(abortInput.reason ? { reason: abortInput.reason } : {}),
          };
          await options.onTerminalizing?.(opened, terminal);
          await catalog.beginRevocation(identity);
          writer = await store.fence({ writer });
          committed = await catalog.revoked(identity);
          const digest = await digestCatalogPrefix(
            store,
            logical.copy.key,
            committed,
          );
          const incomplete = await store.terminate({
            writer,
            expectedByteLength: committed,
            expectedDigest: digest,
          });
          await catalog.recordFailure({ ...identity, ...terminal, digest });
          await options.onTerminate?.(opened, incomplete, terminal);
          appends.clear();
          removeAbort();
        }).catch((error) => {
          terminalTask = undefined;
          throw error;
        });
        await terminalTask;
      };
      const fail = (error: unknown) => {
        failure = error;
        stopped = true;
        clearTimers();
        void abort(
          error instanceof ContentStreamOwnershipLostError
            ? { outcome: "cancelled", reason: "superseded" }
            : { reason: "checkpoint_failed" },
        ).catch(() => undefined);
      };
      const scheduleCheckpoint = () => {
        if (stopped || checkpointTimer !== undefined) return;
        checkpointTimer = setTimeout(() => {
          checkpointTimer = undefined;
          void queue(async () => {
            if (!stopped) await checkpoint();
          }).catch(fail);
        }, Math.max(1, interval - (Date.now() - lastCheckpoint)));
        unref(checkpointTimer);
      };
      const renew = () => {
        if (stopped) return;
        renewTimer = setTimeout(() => {
          renewTimer = undefined;
          if (stopped) return;
          // This owner command is deliberately independent of append I/O.
          void catalog.renew({
            ...identity,
            deadline: new Date(Date.now() + protectionMs).toISOString(),
          }).then(renew, fail);
        }, protectionMs / 2);
        unref(renewTimer);
      };
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          const cancelled = signal.reason instanceof DOMException &&
            signal.reason.name === "AbortError";
          void abort(
            cancelled
              ? { outcome: "cancelled", reason: "cancelled" }
              : { reason: "abandoned" },
          ).catch(() => undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
      try {
        cancelled(options.signal);
        cancelled(openOptions.signal);
        await options.onOpen?.(opened, {
          established() {
            published = true;
          },
        });
        cancelled(options.signal);
        cancelled(openOptions.signal);
        if (!published) {
          throw new Error(
            "Content stream publication must be explicitly established.",
          );
        }
      } catch (error) {
        await abort({ reason: "abandoned" }).catch(() => undefined);
        if (!published) await options.onDiscard?.(opened);
        throw error;
      }
      renew();
      return {
        id,
        offset: () => offset,
        append(appendInput, appendOptions = {}) {
          cancelled(appendOptions.signal);
          const bytes = new Uint8Array(appendInput.bytes),
            appendId = appendInput.appendId.trim();
          if (!appendId || bytes.byteLength > CONTENT_CHUNK_BYTES) {
            throw new TypeError("Append requires an id and a bounded chunk.");
          }
          return queue(async () => {
            if (failure) throw failure;
            if (stopped) throw new ContentStreamOwnershipLostError(id);
            const digest = await digestContent(bytes);
            const prior = appends.get(appendId);
            if (prior) {
              if (
                prior.endOffset - prior.startOffset !== bytes.length ||
                prior.digest !== digest
              ) {
                throw createContentError(
                  "asset_conflict",
                  "Append id was reused with different bytes.",
                );
              }
              return {
                startOffset: prior.startOffset,
                endOffset: prior.endOffset,
              };
            }
            const startOffset = offset;
            if (bytes.byteLength) {
              const result = await store.append({
                writer,
                expectedOffset: startOffset,
                appendId,
                bytes,
              });
              if (
                result.startOffset !== startOffset ||
                result.endOffset < startOffset + bytes.length
              ) {
                throw createContentError(
                  "asset_corrupted",
                  "Physical append returned an invalid receipt.",
                );
              }
              offset = startOffset + bytes.length;
            }
            const result = { startOffset, endOffset: offset };
            appends.set(appendId, { digest, ...result });
            try {
              if (Date.now() - lastCheckpoint >= interval) await checkpoint();
              else scheduleCheckpoint();
            } catch (error) {
              fail(error);
              throw error;
            }
            return result;
          });
        },
        async close(closeInput: ContentStreamCloseInput, closeOptions = {}) {
          cancelled(closeOptions.signal);
          if (closed) return closed;
          if (failure) throw failure;
          if (stopped) throw new ContentStreamOwnershipLostError(id);
          stopped = true;
          clearTimers();
          await queue(async () => {
            await checkpoint();
            const digest = await digestCatalogPrefix(
              store,
              logical.copy.key,
              committed,
            );
            const descriptor = capturePendingContentDescriptor(
              closeInput.descriptor ?? {
                reference: {
                  kind,
                  role,
                  ...(opened.name ? { name: opened.name } : {}),
                  ...(opened.alt ? { alt: opened.alt } : {}),
                  ...(opened.language ? { language: opened.language } : {}),
                  ...(opened.disposition
                    ? { disposition: opened.disposition }
                    : {}),
                  metadata,
                },
                asset: {
                  ...(closeInput.origin ? { origin: closeInput.origin } : {}),
                  metadata: {
                    ...metadata,
                    ...closeInput.metadata,
                    streamId: id,
                  },
                },
              },
            );
            const pendingRef = `pending:${bodyId}`;
            const pending = {
              ref: pendingRef,
              producer: options.producerId ?? id,
              descriptor,
              expiresAt: new Date(Date.now() + CONTENT_REPLAY_RETENTION_MS)
                .toISOString(),
            };
            await catalog.sealIntent({
              ...identity,
              length: committed,
              digest,
              pending,
            });
            await options.onTerminalizing?.(opened, { outcome: "completed" });
            const head = await store.seal({
              writer,
              expectedByteLength: committed,
              expectedDigest: digest,
            });
            await catalog.sealAccepted({ ...identity, head });
            await promoteConfiguredLogicalBody({
              catalog,
              bodyId,
              storeFor: resolveStore,
            });
            await options.onSeal?.(opened, head);
            appends.clear();
            closed = {
              type: "content.pending",
              pendingRef,
              mediaType,
              byteLength: committed,
              digest,
            };
            removeAbort();
          }).catch((error) => {
            failure = error;
            throw error;
          });
          return closed!;
        },
        abort,
        async retain(retention, retainOptions = {}) {
          cancelled(retainOptions.signal);
          if (!closed) {
            throw new Error("Content stream must be sealed before retention.");
          }
          await options.onRetain?.(opened, retention);
        },
        async [Symbol.asyncDispose]() {
          await abort({ reason: "abandoned" });
        },
      };
    },
    async follow(input, followOptions = {}) {
      cancelled(followOptions.signal);
      const bodyId = bodyIdFor(namespace, input.id, options.bodyPrefix),
        start = input.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new TypeError("Invalid follower offset.");
      }
      let initial = await catalog.read(bodyId);
      if (!initial) {
        throw createContentError(
          "content_missing",
          "Stream body is unavailable.",
        );
      }
      let initialHead;
      try {
        initialHead = await resolveStore(initial.copy).head({
          bodyId: initial.copy.key,
        });
        if (!initialHead) {
          throw createContentError(
            "content_missing",
            "Stream copy is unavailable.",
          );
        }
      } catch (error) {
        const next = await catalog.read(bodyId);
        if (!next || next.copy.key === initial.copy.key) throw error;
        initial = next;
        initialHead = await resolveStore(initial.copy).head({
          bodyId: initial.copy.key,
        });
      }
      if (!initialHead) {
        throw createContentError(
          "content_missing",
          "Stream copy is unavailable.",
        );
      }
      const watch = catalog.watch(bodyId);
      let cursor = start, cancelledRead = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (!cancelledRead) {
              cancelled(followOptions.signal);
              const logical = await catalog.read(bodyId);
              if (!logical) {
                throw createContentError(
                  "content_missing",
                  "Stream body is unavailable.",
                );
              }
              const copy = logical.copy, physical = resolveStore(copy);
              try {
                const head = await physical.head({ bodyId: copy.key });
                if (!head) {
                  throw createContentError(
                    "content_missing",
                    "Stream copy is unavailable.",
                  );
                }
                const limit = logical.terminal?.length ?? head.byteLength;
                if (logical.terminal && head.byteLength < limit) {
                  throw createContentError(
                    "content_missing",
                    "Stream copy is shorter than its terminal offset.",
                  );
                }
                if (cursor < limit) {
                  const end = Math.min(limit, cursor + CONTENT_CHUNK_BYTES),
                    bytes = await physical.readRange({
                      bodyId: copy.key,
                      offset: cursor,
                      end,
                    });
                  if (bytes.length !== end - cursor) {
                    throw createContentError(
                      "content_missing",
                      "Stream prefix is incomplete.",
                    );
                  }
                  cursor = end;
                  controller.enqueue(bytes);
                  return;
                }
              } catch (error) {
                const next = await catalog.read(bodyId);
                if (!next || next.copy.key === copy.key) throw error;
                continue;
              }
              if (logical.terminal) {
                watch.close();
                controller.close();
                return;
              }
              await watch.wait();
            }
          } catch (error) {
            watch.close();
            controller.error(error);
          }
        },
        cancel() {
          cancelledRead = true;
          watch.close();
        },
      }, { highWaterMark: 0 });
      return { bodyId, offset: start, mediaType: initialHead.mediaType, body };
    },
  };
}
