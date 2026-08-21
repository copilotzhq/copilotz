import type {
  AppendResult,
  BodyHead,
  BodyStore,
  MutableBodyHead,
  WriterCapability,
} from "./body-store.ts";
import { createContentError } from "./errors.ts";

const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

export type ProgressiveBodyWriter = Readonly<{
  bodyId: string;
  offset(): number;
  append(input: { bytes: Uint8Array; appendId: string }): Promise<
    AppendResult
  >;
  write(chunk: Uint8Array): Promise<void>;
  finalize(): Promise<BodyHead>;
  abandon(): Promise<void>;
}>;

export type ProgressiveBodyFollower = Readonly<{
  bodyId: string;
  offset: number;
  mediaType: string;
  body: ReadableStream<Uint8Array>;
}>;

type LiveBody = {
  bodyId: string;
  mediaType: string;
  byteLength: number;
  discarded: number;
  chunks: Uint8Array[];
  state: "open" | "finalized" | "abandoned";
  writerOpen: boolean;
  maxBufferedBytes: number;
  followers: Set<{ offset: number }>;
  waiters: Set<() => void>;
};

const lives = new WeakMap<BodyStore, Map<string, LiveBody>>();

function livesFor(store: BodyStore): Map<string, LiveBody> {
  const existing = lives.get(store);
  if (existing) return existing;
  const created = new Map<string, LiveBody>();
  lives.set(store, created);
  return created;
}

function notify(live: LiveBody): void {
  const waiters = [...live.waiters];
  live.waiters.clear();
  for (const wake of waiters) wake();
}

function wait(live: LiveBody): Promise<void> {
  return new Promise((resolve) => live.waiters.add(resolve));
}

function minFollowerOffset(live: LiveBody): number {
  if (live.followers.size === 0) return live.byteLength;
  let min = live.byteLength;
  for (const follower of live.followers) {
    if (follower.offset < min) min = follower.offset;
  }
  return Math.max(min, live.discarded);
}

function sliceChunks(
  chunks: readonly Uint8Array[],
  start: number,
  end: number,
): Uint8Array {
  const length = Math.max(0, end - start);
  const output = new Uint8Array(length);
  let cursor = 0;
  let skipped = 0;
  for (const chunk of chunks) {
    const next = skipped + chunk.byteLength;
    if (next <= start) {
      skipped = next;
      continue;
    }
    const from = Math.max(0, start - skipped);
    const to = Math.min(chunk.byteLength, end - skipped);
    output.set(chunk.subarray(from, to), cursor);
    cursor += to - from;
    skipped = next;
    if (skipped >= end) break;
  }
  return output;
}

function readCommitted(
  live: LiveBody,
  offset: number,
  end: number,
): Uint8Array {
  const start = Math.max(offset, live.discarded);
  const stop = Math.min(end, live.byteLength);
  if (stop <= start) return new Uint8Array();
  return sliceChunks(
    live.chunks,
    start - live.discarded,
    stop - live.discarded,
  );
}

export async function createProgressiveBodyWriter(
  store: BodyStore,
  input: Readonly<{
    bodyId: string;
    mediaType: string;
    maxBufferedBytes?: number;
    /** Explicitly fence a writer lost during process recovery. */
    takeover?: boolean;
  }>,
): Promise<ProgressiveBodyWriter> {
  const bodyId = input.bodyId.trim();
  if (!bodyId) throw new TypeError("Progressive bodyId must be non-empty.");
  const table = livesFor(store);
  const existing = table.get(bodyId);
  if (existing?.writerOpen) {
    if (!input.takeover) {
      throw createContentError(
        "asset_conflict",
        "A progressive writer is already open for this asset body.",
      );
    }
    existing.state = "abandoned";
    existing.writerOpen = false;
    notify(existing);
  }
  const takeoverHead = input.takeover ? await store.head({ bodyId }) : null;
  const expectedGeneration = takeoverHead?.state !== "ready"
    ? takeoverHead?.writerGeneration
    : undefined;
  let writer: WriterCapability = await store.reserve({
    bodyId,
    mediaType: input.mediaType,
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  });
  const initialChunks = writer.byteLength > 0
    ? [
      await readStreamBytes(
        await store.follow({
          bodyId,
          offset: writer.discarded,
        }),
      ),
    ]
    : [];
  const live: LiveBody = {
    bodyId,
    mediaType: input.mediaType,
    byteLength: writer.byteLength,
    discarded: writer.discarded,
    chunks: initialChunks,
    state: "open",
    writerOpen: true,
    maxBufferedBytes: Math.max(
      1,
      input.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    ),
    followers: existing?.followers ?? new Set(),
    waiters: existing?.waiters ?? new Set(),
  };
  table.set(bodyId, live);
  notify(live);

  const requireOpen = (): void => {
    if (!live.writerOpen || live.state !== "open") {
      throw createContentError(
        "asset_conflict",
        "Progressive writer is no longer open.",
      );
    }
  };

  const publish = async (): Promise<BodyHead> => {
    const head = await store.seal({
      writer,
      expectedByteLength: live.byteLength,
    });
    live.state = "finalized";
    live.writerOpen = false;
    notify(live);
    return head;
  };

  return Object.freeze({
    bodyId,
    offset: () => live.byteLength,
    async append(input) {
      requireOpen();
      const appendId = input.appendId.trim();
      if (!appendId) throw new TypeError("Progressive appendId is required.");
      const chunk = input.bytes;
      if (chunk.byteLength === 0) {
        return Object.freeze({
          startOffset: live.byteLength,
          endOffset: live.byteLength,
          protection: writer.protection,
        });
      }
      while (
        store.kind === "memory" &&
        live.followers.size > 0 &&
        live.byteLength - minFollowerOffset(live) >= live.maxBufferedBytes
      ) {
        requireOpen();
        await wait(live);
      }
      requireOpen();
      const previousOffset = live.byteLength;
      const result = await store.append({
        writer,
        expectedOffset: previousOffset,
        appendId,
        bytes: chunk,
      });
      if (result.endOffset > previousOffset) {
        live.chunks.push(chunk.slice());
      }
      live.byteLength = result.endOffset;
      writer = {
        ...writer,
        byteLength: result.endOffset,
        protection: result.protection,
      };
      notify(live);
      return result;
    },
    async write(chunk) {
      await this.append({
        bytes: chunk,
        appendId: `offset:${live.byteLength}`,
      });
    },
    async finalize() {
      requireOpen();
      return await publish();
    },
    async abandon() {
      requireOpen();
      live.state = "abandoned";
      live.writerOpen = false;
      notify(live);
      await store.abort({ writer });
      table.delete(bodyId);
    },
  });
}

export async function openProgressiveBodyFollower(
  store: BodyStore,
  input: Readonly<{ bodyId: string; offset?: number }>,
): Promise<ProgressiveBodyFollower> {
  const bodyId = input.bodyId.trim();
  const start = Math.max(0, input.offset ?? 0);
  const live = livesFor(store).get(bodyId);
  if (live?.state === "abandoned") {
    throw createContentError(
      "asset_deleted",
      "Progressive asset body was abandoned.",
    );
  }
  if (live && live.state === "open") {
    if (start < live.discarded) {
      throw createContentError(
        "asset_deleted",
        "Progressive asset prefix was discarded.",
      );
    }
    return followLive(store, live, bodyId, start);
  }

  const stored = await store.head({ bodyId });
  if (stored?.state === "ready") {
    return Object.freeze({
      bodyId,
      offset: start,
      mediaType: stored.mediaType,
      body: await store.follow({ bodyId, offset: start }),
    });
  }

  const staged = stored;
  if (!staged) {
    throw createContentError(
      "asset_not_found",
      "Progressive asset body was not found.",
    );
  }
  if (start < staged.discarded) {
    throw createContentError(
      "asset_deleted",
      "Progressive asset prefix was discarded.",
    );
  }
  return followProgressiveStore(store, staged, bodyId, start);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function followProgressiveStore(
  store: BodyStore,
  initial: MutableBodyHead,
  bodyId: string,
  start: number,
): ProgressiveBodyFollower {
  let cursor = start;
  let discarded = initial.discarded;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        const stored = await store.head({ bodyId });
        if (stored?.state === "ready") {
          const remaining = await readStreamBytes(
            await store.follow({
              bodyId,
              offset: Math.max(0, cursor - discarded),
            }),
          );
          if (remaining.byteLength > 0) controller.enqueue(remaining);
          controller.close();
          return;
        }
        const staged = await store.head({ bodyId });
        if (!staged) {
          // Finalization publishes the immutable body before clearing staging.
          // Recheck it to close the small visibility race between those calls.
          const completed = await store.head({ bodyId });
          if (completed) continue;
          controller.error(
            createContentError(
              "asset_deleted",
              "Progressive asset body was abandoned.",
            ),
          );
          return;
        }
        if (staged.state === "ready") continue;
        discarded = staged.discarded;
        if (cursor < discarded) {
          controller.error(
            createContentError(
              "asset_deleted",
              "Progressive asset prefix was discarded.",
            ),
          );
          return;
        }
        if (staged.byteLength > cursor) {
          const end = staged.byteLength;
          try {
            const startOffset = cursor;
            const bytes = await readStreamBytes(
              await store.follow({
                bodyId,
                offset: startOffset,
              }),
            );
            cursor = end;
            const next = bytes.subarray(0, end - startOffset);
            if (next.byteLength > 0) controller.enqueue(next);
            return;
          } catch (error) {
            const current = await store.head({ bodyId });
            if (current && current.state !== "ready") throw error;
            continue;
          }
        }
        await delay(20);
      }
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return Object.freeze({
    bodyId,
    offset: start,
    mediaType: initial.mediaType,
    body,
  });
}

function followLive(
  store: BodyStore,
  live: LiveBody,
  bodyId: string,
  start: number,
): ProgressiveBodyFollower {
  const cursor = { offset: start };
  live.followers.add(cursor);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (cursor.offset < live.discarded) {
          live.followers.delete(cursor);
          controller.error(
            createContentError(
              "asset_deleted",
              "Progressive asset prefix was discarded.",
            ),
          );
          return;
        }
        if (live.state === "finalized") {
          live.followers.delete(cursor);
          if (cursor.offset < live.byteLength) {
            const stored = await store.follow({
              bodyId,
              offset: Math.max(0, cursor.offset - live.discarded),
            });
            const rest = await readStreamBytes(stored);
            if (rest.byteLength > 0) controller.enqueue(rest);
          }
          controller.close();
          return;
        }
        if (live.byteLength > cursor.offset) {
          const end = live.byteLength;
          const next = readCommitted(live, cursor.offset, end);
          cursor.offset = end;
          notify(live);
          if (next.byteLength > 0) controller.enqueue(next);
          return;
        }
        if (live.state === "abandoned") {
          live.followers.delete(cursor);
          controller.error(
            createContentError(
              "asset_deleted",
              "Progressive asset body was abandoned.",
            ),
          );
          return;
        }
        await wait(live);
      }
    },
    cancel() {
      live.followers.delete(cursor);
      notify(live);
    },
  }, { highWaterMark: 0 });

  return Object.freeze({
    bodyId,
    offset: start,
    mediaType: live.mediaType,
    body,
  });
}

async function readStreamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
