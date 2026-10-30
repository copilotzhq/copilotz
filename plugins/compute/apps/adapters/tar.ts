/**
 * A gzipped tar, read as it streams, with web standards alone: its entries
 * one by one, with their contents when wanted (the rest are skipped, never
 * held). It's what a computer sends of a folder (`computer.archive`): the
 * Cloud Run host looks in it for a Dockerfile, and the local host extracts
 * it. Reads ustar, with pax and GNU long names.
 */

export type TarEntry = {
  /** Its path in the archive, without a leading `./`. */
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  /** A symlink's target. */
  link?: string;
  /** Its contents, when wanted. */
  body?: Uint8Array;
};

const BLOCK = 512;
const decoder = new TextDecoder();

/** Exactly so many bytes at a time from a stream (or skipped), holding only what's asked. */
function bytesOf(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  const more = async () => {
    const next = await reader.read();
    if (next.done) return false;
    if (next.value.length) chunks.push(next.value), held += next.value.length;
    return true;
  };
  const drop = (n: number, into?: Uint8Array) => {
    for (let at = 0; at < n;) {
      const chunk = chunks[0];
      const k = Math.min(chunk.length, n - at);
      into?.set(chunk.subarray(0, k), at);
      if (k === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(k);
      held -= k;
      at += k;
    }
  };
  return {
    /** `n` bytes; null at the stream's end before any. */
    async take(n: number): Promise<Uint8Array | null> {
      while (held < n) {
        if (!await more()) {
          if (held === 0) return null;
          throw new Error("The archive ends in the middle of an entry.");
        }
      }
      const out = new Uint8Array(n);
      drop(n, out);
      return out;
    },
    async skip(n: number): Promise<void> {
      while (n > 0) {
        if (!held && !await more()) throw new Error("The archive ends in the middle of an entry.");
        const k = Math.min(held, n);
        drop(k);
        n -= k;
      }
    },
    /** Reads what's left (a tar's padding after its end), so its sender ends as it meant to. */
    async drain(): Promise<void> {
      chunks.length = held = 0;
      while (!(await reader.read()).done);
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

const text = (block: Uint8Array, at: number, length: number) => {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
};

/** A number field: octal text, or base-256 when its first byte's high bit is set. */
const number = (block: Uint8Array, at: number, length: number) => {
  if (block[at] & 0x80) {
    let value = block[at] & 0x7f;
    for (let i = at + 1; i < at + length; i++) value = value * 256 + block[i];
    return value;
  }
  return parseInt(text(block, at, length).trim() || "0", 8);
};

/** A pax header's records (`<length> <key>=<value>\n`). */
function paxOf(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = parseInt(decoder.decode(data.subarray(at, space)), 10);
    if (!length) break;
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

const clean = (name: string) => name.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");

const TYPES: Record<string, TarEntry["type"]> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "5": "directory",
  "2": "symlink",
};

/**
 * The entries of a tar (gzipped, unless `gzip: false`), in order; those
 * `want` says yes to come with their contents. Stopping early cancels the
 * rest of the stream; reaching the tar's end reads the stream to its end.
 */
export async function* entries(
  stream: ReadableStream<Uint8Array>,
  options: { gzip?: boolean; want?: (entry: TarEntry) => boolean } = {},
): AsyncGenerator<TarEntry> {
  const raw = options.gzip === false ? stream : stream.pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  );
  const bytes = bytesOf(raw);
  let long: { path?: string; linkpath?: string; size?: string } = {};
  let ended = false;
  try {
    for (;;) {
      const header = await bytes.take(BLOCK);
      if (!header || header.every((b) => b === 0)) {
        ended = true;
        return;
      }
      const flag = String.fromCharCode(header[156]);
      let size = number(header, 124, 12);
      if (flag === "x" || flag === "L" || flag === "K" || flag === "g") {
        const block = await bytes.take(Math.ceil(size / BLOCK) * BLOCK);
        if (!block) throw new Error("The archive ends in the middle of an entry.");
        const data = block.subarray(0, size);
        if (flag === "x") long = { ...long, ...paxOf(data) };
        if (flag === "L") long.path = text(data, 0, data.length);
        if (flag === "K") long.linkpath = text(data, 0, data.length);
        continue;
      }
      if (long.size !== undefined) size = Number(long.size);
      const prefix = text(header, 345, 155);
      const named = text(header, 0, 100);
      const entry: TarEntry = {
        name: clean(long.path ?? (prefix ? `${prefix}/${named}` : named)),
        type: TYPES[flag] ?? "other",
        size,
        mode: number(header, 100, 8),
        ...(flag === "2" ? { link: long.linkpath ?? text(header, 157, 100) } : {}),
      };
      long = {};
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (entry.type === "file" && options.want?.(entry)) {
        entry.body = (await bytes.take(padded))?.subarray(0, size) ?? new Uint8Array();
      } else await bytes.skip(padded);
      if (entry.name) yield entry;
    }
  } finally {
    // Read to its end, the rest is only padding; stopped early, the rest is let go.
    if (ended) await bytes.drain().catch(() => bytes.cancel());
    else await bytes.cancel();
  }
}

/** Whether a folder's archive has a Dockerfile at its top. */
export async function hasDockerfile(stream: ReadableStream<Uint8Array>): Promise<boolean> {
  for await (const entry of entries(stream)) {
    if (entry.type === "file" && entry.name === "Dockerfile") return true;
  }
  return false;
}
