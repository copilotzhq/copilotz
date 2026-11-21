/**
 * Bytes sent on to a computer as streamed work takes them (`computer.http`,
 * `computer.files.put`): a head, one JSON line, then a body as it comes, in
 * chunks under Oxian's data frame (1 MiB).
 */

/** The most a chunk of a body is, on its way. */
export const CHUNK = 256 * 1024;

const encoder = new TextEncoder();

/**
 * `head` as one JSON line, then `body`. The body is read only once the
 * line has gone and more is asked for: a computer found offline (refused
 * before anything is read) leaves it whole, for a try with a new stream.
 */
export function headed(
  head: unknown,
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let headSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(encoder.encode(`${JSON.stringify(head)}\n`));
        return;
      }
      if (!body) return controller.close();
      reader ??= body.getReader();
      const { done, value } = await reader.read();
      if (done) return controller.close();
      for (let i = 0; i < value.length; i += CHUNK) {
        controller.enqueue(value.subarray(i, i + CHUNK));
      }
    },
    cancel: (reason) => reader?.cancel(reason),
  });
}
