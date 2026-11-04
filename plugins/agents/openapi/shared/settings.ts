/** An API's settings, as configured (`resources.openapi.<name>`), with their defaults. */
import type { Resources } from "../../../../runtime/mod.ts";
import type { OpenApiSettings } from "../contract.ts";

export const TIMEOUT = 30_000;
export const MAX_BYTES = 100_000;
export const MAX_FILE_BYTES = 10_000_000;
/**
 * Media types a file may have unless the settings say: images, PDFs, audio,
 * video and plain text, never what a browser would run (HTML, SVG).
 */
export const FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "audio/*",
  "video/*",
  "text/plain",
  "text/csv",
];

export type Settings = OpenApiSettings & {
  timeout: number;
  maxBytes: number;
  maxFileBytes: number;
  fileTypes: string[];
};

export const settingsOf = (ctx: { resources: Resources }, api: string): Settings => {
  const given = ((ctx.resources.openapi ?? {}) as Record<string, OpenApiSettings>)[api] ?? {};
  return {
    ...given,
    timeout: given.timeout ?? TIMEOUT,
    maxBytes: given.maxBytes ?? MAX_BYTES,
    maxFileBytes: given.maxFileBytes ?? MAX_FILE_BYTES,
    fileTypes: given.fileTypes ?? FILE_TYPES,
  };
};

/** How a number of bytes reads: `100 KB`, `10 MB`. */
export const sized = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${+(bytes / 1_000_000).toFixed(1)} MB`
    : bytes >= 1000
    ? `${+(bytes / 1000).toFixed(1)} KB`
    : `${bytes} bytes`;
