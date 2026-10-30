/**
 * When a call breaks: which failures pass (the network, a stream gone
 * silent, a provider timing out or busy), how long to wait before trying
 * again (longer each time), and a stream that counts as broken once it
 * sends nothing for a while, whatever its adapter does with the signal.
 */

/** How long a model may send nothing before its connection counts as dropped (2 minutes). */
export const SILENCE = 120_000;
/** How long a call that broke is tried again (2 minutes). */
export const RETRY = 120_000;

const stalled = (ms: number) =>
  Object.assign(new Error(`No answer from the model for ${Math.round(ms / 1000)} s`), {
    code: "stalled",
  });

/** A failure worth trying again: the connection, a silent stream, a provider timing out or busy. */
export function transient(error: unknown): boolean {
  const e = error as { code?: string; status?: number; name?: string; cause?: { code?: string } };
  if (e?.code === "stalled") return true;
  if (typeof e?.status === "number") {
    return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(e.status);
  }
  // fetch's own failures: the network, a reset, a refused connection.
  if (error instanceof TypeError) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]
    .includes(e?.code ?? e?.cause?.code ?? "");
}

/** How long to wait before attempt `n + 1`: 1 s, 2 s, 4 s… up to 30 s, give or take a fifth. */
export const backoff = (n: number) =>
  Math.round(Math.min(1000 * 2 ** (n - 1), 30_000) * (0.8 + Math.random() * 0.4));

/** Waits `ms`, or until `signal` stops it. */
export const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * `stream`, failing as stalled once nothing comes for `ms`: it aborts
 * `quiet` (which the adapter's request listens to) and stops waiting
 * either way.
 */
export async function* quietly<T>(
  stream: AsyncIterable<T>,
  ms: number,
  quiet: AbortController,
): AsyncGenerator<T> {
  const it = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silent = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = stalled(ms);
          quiet.abort(error);
          reject(error);
        }, ms);
      });
      try {
        const next = await Promise.race([it.next(), silent]);
        if (next.done) return;
        yield next.value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    void it.return?.()?.catch?.(() => {});
  }
}
