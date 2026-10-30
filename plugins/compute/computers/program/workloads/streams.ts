/**
 * What workloads that stream raw bytes share (an HTTP exchange, an archive),
 * where the rest answer one JSON value (answer.ts): an input whose first
 * line is JSON (its head) and whose rest is bytes as they come, and output
 * in chunks Oxian carries (one data frame, 1 MiB at most, each).
 */
import { failure } from "./answer.ts";

/** The most one chunk of output can be (Oxian's data frame), and a head line. */
export const CHUNK = 1024 * 1024;

const LF = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One JSON line: a head, or (`failed`) what an error answers. */
export const jsonLine = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value) + "\n");

/** What failed work streams: its failure, as one JSON line (`Failed`). */
export const failedLine = (error: unknown): Uint8Array => jsonLine(failure(error));

/**
 * `input`'s first line, parsed as JSON, and what follows it as a stream of
 * its own (cancelling it cancels `input`). A line longer than `CHUNK`, or
 * input that ends before one, is refused (`invalid`).
 */
export async function splitHead(
  input: ReadableStream<Uint8Array>,
): Promise<{ head: unknown; rest: ReadableStream<Uint8Array> }> {
  const reader = input.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let after: Uint8Array | undefined;
  while (after === undefined) {
    const { value, done } = await reader.read();
    if (done) {
      throw Object.assign(new Error("The input ended before its head line"), { code: "invalid" });
    }
    const at = value.indexOf(LF);
    parts.push(at < 0 ? value : value.subarray(0, at));
    size += at < 0 ? value.length : at;
    if (size > CHUNK) {
      void reader.cancel().catch(() => {});
      throw Object.assign(new Error("The head line is too long"), { code: "invalid" });
    }
    if (at >= 0) after = value.subarray(at + 1);
  }
  const line = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    line.set(part, offset);
    offset += part.length;
  }
  let head: unknown;
  try {
    head = JSON.parse(decoder.decode(line));
  } catch {
    void reader.cancel().catch(() => {});
    throw Object.assign(new Error("The head line isn't JSON"), { code: "invalid" });
  }
  let first: Uint8Array | undefined = after.length ? after : undefined;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        controller.enqueue(first);
        first = undefined;
        return;
      }
      const { value, done } = await reader.read();
      if (done) controller.close();
      else if (value.length) controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head, rest };
}

/**
 * `source` (after `first`, when given) in chunks no bigger than `CHUNK`;
 * cancelling it cancels `source`.
 */
export function bounded(
  source: ReadableStream<Uint8Array> | null,
  first?: Uint8Array,
): ReadableStream<Uint8Array> {
  const reader = source?.getReader();
  let staged = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!staged?.length) {
        const next = reader ? await reader.read() : { done: true as const, value: undefined };
        if (next.done) return controller.close();
        staged = next.value;
      }
      controller.enqueue(staged.subarray(0, CHUNK));
      staged = staged.subarray(CHUNK);
    },
    cancel: (reason) => reader?.cancel(reason),
  }, { highWaterMark: 0 });
}
