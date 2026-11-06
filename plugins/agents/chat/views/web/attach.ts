/** Files chosen to send: read as `chat.send` takes them (base64), with a preview for images. */

import { formatNumber } from "../../../../../hosts/web/words.ts";
import { say } from "./words.ts";

export type Attached = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Its content, base64, once read. */
  data?: string;
  /** An image's preview (an object URL), until it's sent or removed. */
  preview?: string;
  /** Why it can't go. */
  error?: string;
};

/** How many files a message takes, and how large each may be. */
export const FILES = 10;
export const BYTES = 10 * 1_048_576;

/** A file as chosen: what it is; its content is read next (`read`). */
export const chosen = (file: File): Attached => ({
  id: crypto.randomUUID(),
  name: file.name || say("pastedFile"),
  type: file.type || "application/octet-stream",
  size: file.size,
  ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
  ...(file.size > BYTES ? { error: say("overLimit") } : {}),
});

/** A file's content (or a recording's), base64. */
export const read = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Bytes, as people read them. */
export const size = (bytes: number): string =>
  bytes < 1024
    ? say("bytes", { n: formatNumber(bytes) })
    : bytes < 1_048_576
    ? say("kilobytes", { n: oneDecimal(bytes / 1024, bytes < 10_240 ? 1 : 0) })
    : say("megabytes", { n: oneDecimal(bytes / 1_048_576, 1) });

/** A number with exactly `digits` decimals, as the page's language writes it. */
const oneDecimal = (n: number, digits: number) =>
  formatNumber(Number(n.toFixed(digits)), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
