/** Files chosen to send: read as `chat.send` takes them (base64), with a preview for images. */

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
  name: file.name || "pasted file",
  type: file.type || "application/octet-stream",
  size: file.size,
  ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
  ...(file.size > BYTES ? { error: "Over 10 MB" } : {}),
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
    ? `${bytes} B`
    : bytes < 1_048_576
    ? `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
