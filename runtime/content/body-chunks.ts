/** Shared physical byte slicing; callers validate the requested range. */
export function sliceBodyChunks(
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
