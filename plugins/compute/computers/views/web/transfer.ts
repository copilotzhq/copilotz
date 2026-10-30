/// <reference lib="dom" />
/**
 * Files off the computer, for the browser: what kind a file is by its name
 * (an image, and which), a whole file read in parts (`files.read` answers
 * at most 16 MiB at a time, as text or base64), and saving one to the
 * person's own disk.
 */
import type { FilesRead } from "../../shared/workloads.ts";
import type { Work } from "./names.ts";

/** Images the browser shows, by extension, and their types. */
const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** An image's type, by its name; undefined for anything else. */
export const imageType = (name: string): string | undefined =>
  IMAGES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];

/** The most a read answers. */
export const MOST = 16 * 1024 * 1024;
/** What a download reads at a time. */
const PART = 4 * 1024 * 1024;

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** A read's bytes: its text as UTF-8, or its base64 decoded. */
export const bytesOf = (read: Pick<FilesRead, "content" | "encoding">): Uint8Array =>
  read.encoding === "base64" ? decode(read.content) : new TextEncoder().encode(read.content);

/** The whole file, in parts. */
export async function readAll(work: Work, path: string): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (let offset = 0;;) {
    const part = await work<FilesRead>("files.read", { path, offset, length: PART });
    const bytes = bytesOf(part);
    parts.push(bytes);
    offset += bytes.length;
    if (!part.truncated || !bytes.length) return parts;
  }
}

/** Saves bytes to the person's disk, as `name`. */
export function save(parts: Uint8Array[], name: string, type?: string): void {
  const url = URL.createObjectURL(
    new Blob(parts as BlobPart[], type ? { type } : {}),
  );
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
