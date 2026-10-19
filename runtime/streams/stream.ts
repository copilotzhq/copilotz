import { withoutOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import {
  contentStreamBodyId,
  contentStreamIncarnationId,
} from "./body-identity.ts";
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
  ContentStreamWriter,
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

type ScheduledWriterCommand = <T>(run: () => T | Promise<T>) => Promise<T>;
type WriterLifetime = {
  observeFailure(onFailure: (reason: unknown) => void): () => void;
  bindCommands(scheduled: ScheduledWriterCommand): void;
};
/** Package-private lifecycle: immutable handles, with the first invocation owning scheduling. */
export const contentStreamLifecycle = Symbol("content stream lifecycle");
const lifetimeOf = (writer: object) =>
  (writer as { [contentStreamLifecycle]?: WriterLifetime })[
    contentStreamLifecycle
  ];
type Terminalizer = NonNullable<
  CreateContentStreamRuntimeOptions["onTerminalizing"]
>;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length",
)!.get!;
const copyBytes = Uint8Array.prototype.set;

/** The first acquiring invocation owns scheduled policy for this exact writer. */
export function bindContentStreamCommands(
  writer: object,
  scheduled: ScheduledWriterCommand,
): void {
  lifetimeOf(writer)?.bindCommands(scheduled);
}

/** Package-only lifetime observation for the invocation that owns this writer. */
export function observeContentStreamFailure(
  writer: object,
  onFailure: (reason: unknown) => void,
): () => void {
  return lifetimeOf(writer)?.observeFailure(onFailure) ?? (() => {});
}

export class ContentStreamOwnershipLostError extends Error {
  readonly code = "content_stream_ownership_lost";
  constructor(streamId: string) {
    super(`Content stream '${streamId}' lost durable write ownership.`);
    this.name = "ContentStreamOwnershipLostError";
  }
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
  return createStreamRuntime(options);
}
/** Owner cleanup is wired at construction, separately from caller callbacks. */
export function createOwnerContentStreamRuntime(
  options: CreateContentStreamRuntimeOptions,
  terminalize: Terminalizer,
): ContentStreamRuntime {
  return createStreamRuntime(options, terminalize);
}
function createStreamRuntime(
  options: CreateContentStreamRuntimeOptions,
  ownerTerminalize?: Terminalizer,
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
      const id = contentStreamIncarnationId(semanticId, incarnation);
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
      const bodyId = contentStreamBodyId(namespace, id, options.bodyPrefix);
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
      const failure = new AbortController();
      let scheduledCommand: ScheduledWriterCommand | undefined;
      const lifetime: WriterLifetime = Object.freeze({
        observeFailure(onFailure: (reason: unknown) => void) {
          const notify = () => onFailure(failure.signal.reason);
          failure.signal.addEventListener("abort", notify, { once: true });
          if (failure.signal.aborted) notify();
          return () => failure.signal.removeEventListener("abort", notify);
        },
        bindCommands(scheduled: ScheduledWriterCommand) {
          scheduledCommand ??= scheduled;
        },
      });
      const scheduled = async <T>(run: () => T | Promise<T>): Promise<T> =>
        await (scheduledCommand ? scheduledCommand(run) : run());
      let terminalAccepted = false, aborting = false;
      let pendingAppends = 0;
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
      // Only an owner-observed failure or the captured invocation cancellation
      // admits these fixed revocation steps outside a completed capability call.
      const cleanup = async <T>(run: () => T | Promise<T>): Promise<T> =>
        await (failure.signal.aborted || options.signal?.aborted
          ? withoutOwnerCommandAuthorization(run)
          : run());
      const captureAbort = (abortInput: ContentStreamAbortInput) => {
        const requested = {
          outcome: abortInput.outcome ?? "failed",
          reason: abortInput.reason,
        };
        if (
          (requested.outcome !== "failed" &&
            requested.outcome !== "cancelled") ||
          (requested.reason !== undefined &&
            typeof requested.reason !== "string")
        ) {
          throw new TypeError(
            "Abort requires a failed or cancelled outcome and a string reason.",
          );
        }
        const observed = failure.signal.aborted
          ? failure.signal.reason instanceof ContentStreamOwnershipLostError
            ? { outcome: "cancelled" as const, reason: "superseded" }
            : { outcome: "failed" as const, reason: "writer_failed" }
          : options.signal?.aborted
          ? options.signal.reason instanceof DOMException &&
              options.signal.reason.name === "AbortError"
            ? { outcome: "cancelled" as const, reason: "cancelled" }
            : { outcome: "failed" as const, reason: "abandoned" }
          : requested;
        const { outcome, reason } = observed;
        return { outcome, ...(reason ? { reason } : {}) };
      };
      let selectedTerminal: ReturnType<typeof captureAbort> | undefined;
      const terminate = async (
        requested: ReturnType<typeof captureAbort>,
        runFixed: ScheduledWriterCommand,
      ) => {
        const terminal = selectedTerminal ??= requested;
        aborting = true;
        stopped = true;
        clearTimers();
        terminalTask ??= queue(async () => {
          const current = await runFixed(() =>
            catalog.beginRevocation(identity)
          );
          // A seal can have committed even if its reply was lost. Its accepted
          // terminal wins over late failure and must never be fenced/replaced.
          if (current.terminal) {
            terminalAccepted = current.terminal.outcome === "completed";
            appends.clear();
            removeAbort();
            return;
          }
          if (ownerTerminalize) {
            await runFixed(() => ownerTerminalize(opened, terminal));
          }
          await options.onTerminalizing?.(opened, terminal);
          writer = await runFixed(() => store.fence({ writer }));
          committed = await runFixed(() => catalog.revoked(identity));
          await runFixed(() =>
            catalog.recordFailure({ ...identity, ...terminal })
          );
          await options.onTerminate?.(opened, {
            bodyId: logical.bodyId,
            byteLength: committed,
          }, terminal);
          appends.clear();
          removeAbort();
        }).catch((error) => {
          terminalTask = undefined;
          throw error;
        });
        await terminalTask;
      };
      const abort = async (
        abortInput: ContentStreamAbortInput = {},
        abortOptions: { signal?: AbortSignal } = {},
      ) => {
        cancelled(abortOptions.signal);
        if (closed || terminalAccepted) return;
        const terminal = captureAbort(abortInput);
        // Public retries retain the current call authority, even after failure.
        await terminate(terminal, async (run) => await run());
      };
      const abortObserved = async (input: ContentStreamAbortInput) => {
        if (closed || terminalAccepted) return;
        // Only the owner-created failure/cancellation closures reach this entry.
        await terminate(captureAbort(input), cleanup);
      };
      const fail = (error: unknown) => {
        if (failure.signal.aborted) return;
        stopped = true;
        clearTimers();
        // Start existing fence/recovery before notifying the owning invocation.
        // Its cleanup can join this task, but cannot turn the failure into success.
        void abortObserved(
          error instanceof ContentStreamOwnershipLostError
            ? { outcome: "cancelled", reason: "superseded" }
            : { reason: "writer_failed" },
        ).catch(() => undefined);
        failure.abort(error);
      };
      const scheduleCheckpoint = () => {
        if (stopped || checkpointTimer !== undefined) return;
        checkpointTimer = setTimeout(() => {
          checkpointTimer = undefined;
          void queue(async () => {
            if (!stopped) await scheduled(checkpoint);
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
          void scheduled(() =>
            catalog.renew({
              ...identity,
              deadline: new Date(Date.now() + protectionMs).toISOString(),
            })
          ).then(renew, (error) => {
            if (!terminalAccepted && !aborting) fail(error);
          });
        }, protectionMs / 2);
        unref(renewTimer);
      };
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          const cancelled = signal.reason instanceof DOMException &&
            signal.reason.name === "AbortError";
          void abortObserved(
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
      const streamWriter: ContentStreamWriter = {
        id,
        offset: () => offset,
        append(appendInput, appendOptions = {}) {
          cancelled(appendOptions.signal);
          if (pendingAppends >= 2) {
            throw new RangeError("Content stream append capacity is full.");
          }
          // Admit before inspecting/copying caller bytes, including reentrant getters.
          pendingAppends++;
          let bytes: Uint8Array, appendId: string;
          try {
            appendId = appendInput.appendId.trim();
            const inputBytes = appendInput.bytes;
            const length = typedArrayLength.call(inputBytes);
            if (
              !appendId || !(inputBytes instanceof Uint8Array) ||
              length > CONTENT_CHUNK_BYTES
            ) {
              throw new TypeError("Append requires an id and a bounded chunk.");
            }
            // Built-in accessors/copy avoid caller iterators and shadowed lengths.
            bytes = new Uint8Array(length);
            copyBytes.call(bytes, inputBytes);
          } catch (error) {
            pendingAppends--;
            throw error;
          }
          return queue(async () => {
            failure.signal.throwIfAborted();
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
              let result;
              try {
                result = await store.append({
                  writer,
                  expectedOffset: startOffset,
                  appendId,
                  bytes,
                });
              } catch (error) {
                fail(error);
                throw error;
              } finally {
                // A rejected storage reply may still have written tentative bytes.
                catalog.notifyPhysicalChange(bodyId);
              }
              if (
                result.startOffset !== startOffset ||
                result.endOffset < startOffset + bytes.length
              ) {
                const error = createContentError(
                  "asset_corrupted",
                  "Physical append returned an invalid receipt.",
                );
                fail(error);
                throw error;
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
          }).finally(() => pendingAppends--);
        },
        async close(closeInput: ContentStreamCloseInput, closeOptions = {}) {
          cancelled(closeOptions.signal);
          if (closed) return closed;
          failure.signal.throwIfAborted();
          if (stopped) throw new ContentStreamOwnershipLostError(id);
          stopped = true;
          clearTimers();
          await queue(async () => {
            failure.signal.throwIfAborted();
            const digest = await digestCatalogPrefix(
              store,
              logical.copy.key,
              offset,
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
            failure.signal.throwIfAborted();
            await catalog.sealIntent({
              ...identity,
              length: offset,
              ...(offset !== committed ? { expectedOffset: committed } : {}),
              digest,
              pending,
            });
            if (offset !== committed) {
              const startOffset = committed;
              committed = offset;
              lastCheckpoint = Date.now();
              await options.onAppend?.(opened, {
                startOffset,
                endOffset: committed,
              });
            }
            await ownerTerminalize?.(opened, { outcome: "completed" });
            await options.onTerminalizing?.(opened, { outcome: "completed" });
            failure.signal.throwIfAborted();
            const head = await store.seal({
              writer,
              expectedByteLength: committed,
              expectedDigest: digest,
            });
            failure.signal.throwIfAborted();
            await catalog.sealAccepted({ ...identity, head });
            terminalAccepted = true;
            failure.signal.throwIfAborted();
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
            fail(error);
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
      Object.defineProperty(streamWriter, contentStreamLifecycle, {
        value: lifetime,
      });
      return streamWriter;
    },
    async follow(input, followOptions = {}) {
      cancelled(followOptions.signal);
      const bodyId = contentStreamBodyId(
          namespace,
          input.id,
          options.bodyPrefix,
        ),
        start = input.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new TypeError("Invalid follower offset.");
      }
      const watch = await catalog.watch(bodyId);
      const stopWatching = () => watch.close();
      followOptions.signal?.addEventListener("abort", stopWatching, {
        once: true,
      });
      const closeWatch = () => {
        followOptions.signal?.removeEventListener("abort", stopWatching);
        watch.close();
      };
      let initialHead;
      try {
        cancelled(followOptions.signal);
        let initial = await catalog.read(bodyId);
        if (!initial) {
          throw createContentError(
            "content_missing",
            "Stream body is unavailable.",
          );
        }
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
      } catch (error) {
        closeWatch();
        throw error;
      }
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
                closeWatch();
                controller.close();
                return;
              }
              await watch.wait();
            }
          } catch (error) {
            closeWatch();
            controller.error(error);
          }
        },
        cancel() {
          cancelledRead = true;
          closeWatch();
        },
      }, { highWaterMark: 0 });
      return { bodyId, offset: start, mediaType: initialHead.mediaType, body };
    },
  };
}
