import type {
  AssetBodyHead,
  AssetBodySpill,
  AssetBodySpillHead,
  AssetBodyStore,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";

const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

export type ProgressiveBodyWriter = Readonly<{
  key: string;
  offset(): number;
  discarded(): number;
  write(chunk: Uint8Array): Promise<void>;
  retain(byteLength?: number): Promise<AssetBodyHead>;
  discard(byteLength?: number): Promise<void>;
  finalize(): Promise<AssetBodyHead>;
  abandon(): Promise<void>;
}>;

export type ProgressiveBodyFollower = Readonly<{
  key: string;
  offset: number;
  mediaType: string;
  body: ReadableStream<Uint8Array>;
}>;

type LiveBody = {
  key: string;
  mediaType: string;
  chunks: Uint8Array[];
  byteLength: number;
  discarded: number;
  state: "open" | "finalized" | "abandoned";
  writerOpen: boolean;
  maxBufferedBytes: number;
  spill?: AssetBodySpill;
  followers: Set<{ offset: number }>;
  waiters: Set<() => void>;
};

const lives = new WeakMap<AssetBodyStore, Map<string, LiveBody>>();

function livesFor(store: AssetBodyStore): Map<string, LiveBody> {
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

function requireRange(
  live: LiveBody,
  byteLength: number,
  action: string,
): number {
  if (byteLength < live.discarded || byteLength > live.byteLength) {
    throw createContentError(
      "content_invalid",
      `Progressive ${action} is outside the committed range.`,
    );
  }
  return byteLength;
}

async function readCommitted(
  live: LiveBody,
  offset: number,
  end: number,
): Promise<Uint8Array> {
  const start = Math.max(offset, live.discarded);
  const stop = Math.min(end, live.byteLength);
  if (stop <= start) return new Uint8Array();
  if (live.spill) {
    return await live.spill.read({ key: live.key, offset: start, end: stop });
  }
  return sliceChunks(
    live.chunks,
    start - live.discarded,
    stop - live.discarded,
  );
}

export async function createProgressiveBodyWriter(
  store: AssetBodyStore,
  input: Readonly<{
    key: string;
    mediaType: string;
    maxBufferedBytes?: number;
    /** Explicitly fence a writer lost during process recovery. */
    takeover?: boolean;
  }>,
): Promise<ProgressiveBodyWriter> {
  const key = input.key.trim();
  if (!key) throw new TypeError("Progressive body key must be non-empty.");
  const spill = store.kind === "memory" ? undefined : store.spill;
  if (store.kind !== "memory" && !spill) {
    throw createContentError(
      "asset_storage_unavailable",
      "Progressive writes require spill on filesystem, database, and object stores.",
    );
  }
  const table = livesFor(store);
  const existing = table.get(key);
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
  const reservationId = crypto.randomUUID();
  const staged = await spill?.reserve({
    key,
    mediaType: input.mediaType,
    reservationId,
    takeover: input.takeover,
  });
  const live: LiveBody = {
    key,
    mediaType: input.mediaType,
    chunks: [],
    byteLength: staged?.byteLength ?? 0,
    discarded: staged?.discarded ?? 0,
    state: "open",
    writerOpen: true,
    maxBufferedBytes: Math.max(
      1,
      input.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    ),
    spill,
    followers: existing?.followers ?? new Set(),
    waiters: existing?.waiters ?? new Set(),
  };
  table.set(key, live);
  notify(live);

  const requireOpen = (): void => {
    if (!live.writerOpen || live.state !== "open") {
      throw createContentError(
        "asset_conflict",
        "Progressive writer is no longer open.",
      );
    }
  };

  const publish = async (): Promise<AssetBodyHead> => {
    const bytes = await readCommitted(live, live.discarded, live.byteLength);
    const digest = await digestContent(bytes);
    const head = await store.put({
      key,
      bytes,
      mediaType: live.mediaType,
      digest,
    });
    live.state = "finalized";
    live.writerOpen = false;
    notify(live);
    await live.spill?.delete(key, reservationId);
    return head;
  };

  return Object.freeze({
    key,
    offset: () => live.byteLength,
    discarded: () => live.discarded,
    async write(chunk) {
      requireOpen();
      if (chunk.byteLength === 0) return;
      if (!live.spill) {
        while (
          live.followers.size > 0 &&
          live.byteLength - minFollowerOffset(live) >= live.maxBufferedBytes
        ) {
          requireOpen();
          await wait(live);
        }
        requireOpen();
        live.chunks.push(chunk.slice());
        live.byteLength += chunk.byteLength;
        notify(live);
        return;
      }
      const head = await live.spill.append({
        key,
        mediaType: live.mediaType,
        reservationId,
        bytes: chunk,
      });
      live.byteLength = head.byteLength;
      live.discarded = head.discarded;
      notify(live);
    },
    async retain(byteLength) {
      requireOpen();
      const n = requireRange(live, byteLength ?? live.byteLength, "retain");
      if (n < live.byteLength) {
        if (live.spill) {
          await live.spill.truncate(key, n, reservationId);
        } else {
          live.chunks = [
            sliceChunks(live.chunks, 0, n - live.discarded),
          ].filter((chunk) => chunk.byteLength > 0);
        }
        live.byteLength = n;
      }
      return await publish();
    },
    async discard(byteLength) {
      requireOpen();
      const n = requireRange(live, byteLength ?? live.byteLength, "discard");
      if (n === live.discarded) return;
      if (live.spill) {
        const head = await live.spill.discardPrefix(key, n, reservationId);
        live.discarded = head.discarded;
        live.byteLength = head.byteLength;
      } else {
        live.chunks = [
          sliceChunks(
            live.chunks,
            n - live.discarded,
            live.byteLength - live.discarded,
          ),
        ].filter((chunk) => chunk.byteLength > 0);
        live.discarded = n;
      }
      notify(live);
    },
    async finalize() {
      requireOpen();
      return await publish();
    },
    async abandon() {
      requireOpen();
      live.state = "abandoned";
      live.writerOpen = false;
      live.chunks = [];
      notify(live);
      await live.spill?.delete(key, reservationId);
      table.delete(key);
    },
  });
}

export async function openProgressiveBodyFollower(
  store: AssetBodyStore,
  input: Readonly<{ key: string; offset?: number }>,
): Promise<ProgressiveBodyFollower> {
  const key = input.key.trim();
  const start = Math.max(0, input.offset ?? 0);
  const live = livesFor(store).get(key);
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
    return followLive(store, live, key, start);
  }

  const stored = await store.head(key);
  if (stored) {
    return Object.freeze({
      key,
      offset: start,
      mediaType: stored.mediaType,
      body: skipOffset(await store.open(key), start),
    });
  }

  const staged = await store.spill?.head(key);
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
  return followSpill(store, staged, key, start);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function followSpill(
  store: AssetBodyStore,
  initial: AssetBodySpillHead,
  key: string,
  start: number,
): ProgressiveBodyFollower {
  const spill = store.spill!;
  let cursor = start;
  let discarded = initial.discarded;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        const stored = await store.head(key);
        if (stored) {
          const remaining = await readStreamBytes(
            skipOffset(await store.open(key), Math.max(0, cursor - discarded)),
          );
          if (remaining.byteLength > 0) controller.enqueue(remaining);
          controller.close();
          return;
        }
        const staged = await spill.head(key);
        if (!staged) {
          // Finalization publishes the immutable body before clearing staging.
          // Recheck it to close the small visibility race between those calls.
          const completed = await store.head(key);
          if (completed) continue;
          controller.error(
            createContentError(
              "asset_deleted",
              "Progressive asset body was abandoned.",
            ),
          );
          return;
        }
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
            const bytes = await spill.read({ key, offset: cursor, end });
            cursor = end;
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            return;
          } catch (error) {
            if (await spill.head(key)) throw error;
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
    key,
    offset: start,
    mediaType: initial.mediaType,
    body,
  });
}

function followLive(
  store: AssetBodyStore,
  live: LiveBody,
  key: string,
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
            const stored = skipOffset(
              await store.open(key),
              Math.max(0, cursor.offset - live.discarded),
            );
            const rest = await readStreamBytes(stored);
            if (rest.byteLength > 0) controller.enqueue(rest);
          }
          controller.close();
          return;
        }
        if (live.byteLength > cursor.offset) {
          const end = live.byteLength;
          const next = await readCommitted(live, cursor.offset, end);
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
    key,
    offset: start,
    mediaType: live.mediaType,
    body,
  });
}

function skipOffset(
  stream: ReadableStream<Uint8Array>,
  offset: number,
): ReadableStream<Uint8Array> {
  if (offset <= 0) return stream;
  let remaining = offset;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (remaining <= 0) {
          controller.enqueue(chunk);
          return;
        }
        if (chunk.byteLength <= remaining) {
          remaining -= chunk.byteLength;
          return;
        }
        const rest = chunk.subarray(remaining);
        remaining = 0;
        controller.enqueue(rest);
      },
    }),
  );
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
