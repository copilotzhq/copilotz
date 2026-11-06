/**
 * A request's body, read within a limit: what routes read their JSON and
 * webhooks' bytes with, so a request too large is refused before it's all
 * read.
 */

/**
 * A request's body, `most` bytes at most: undefined past it, said by its
 * `content-length` before anything is read, or found while reading, which
 * stops there (the rest is never read).
 */
export async function bodyOf(request: Request, most: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  if (Number(request.headers.get("content-length") ?? 0) > most) {
    await request.body.cancel().catch(() => {});
    return undefined;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > most) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * A request's JSON object, `most` bytes at most (16 KiB unless said): `{}`
 * with no body; undefined when it's too large, or not an object.
 */
export async function jsonOf(
  request: Request,
  most = 16_384,
): Promise<Record<string, unknown> | undefined> {
  const bytes = await bodyOf(request, most);
  if (!bytes) return undefined;
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
