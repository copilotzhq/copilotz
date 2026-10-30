/** A gzipped tar of these files (ustar; a long path goes in a pax header), as a computer sends a folder. */

const encoder = new TextEncoder();

function header(name: string, size: number, type: string, mode = 0o644): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, text: string) => block.set(encoder.encode(text), at);
  const octal = (at: number, length: number, value: number) =>
    put(at, value.toString(8).padStart(length - 1, "0"));
  put(0, name.slice(0, 100));
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, Math.floor(Date.now() / 1000));
  block.fill(0x20, 148, 156);
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  const sum = block.reduce((total, b) => total + b, 0);
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

const padded = (data: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};

/** The tar itself. */
export function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    if (name.length > 100) {
      const record = (length: number) => `${length} path=${name}\n`;
      let length = record(0).length;
      while (record(length).length !== length) length = record(length).length;
      const pax = encoder.encode(record(length));
      parts.push(header("PaxHeader", pax.length, "x"), padded(pax));
    }
    parts.push(header(name, data.length, "0", name.endsWith(".sh") ? 0o755 : 0o644));
    parts.push(padded(data));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) out.set(part, at), at += part.length;
  return out;
}

/** The tar, gzipped. */
export async function tgz(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([tar(files) as BlobPart]).stream().pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes as a stream, in chunks of `size`. */
export function streamOf(bytes: Uint8Array, size = 100): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}
