/** Normalizes durable Content inputs shared by Core storage Actions. @module */

import {
  base64ToBytes,
  type ContentInput,
  type ContentRef,
  type ContentSequence,
  type DurableContentInput,
  parseDataUrl,
  type PreparedContent,
} from "@copilotz/copilotz/content";
import type { ActionContext } from "@copilotz/copilotz/actions";

/** Shared content helpers for Core Actions. */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isContentRef(value: unknown): value is ContentRef {
  const record = asRecord(value);
  return typeof record.assetId === "string" &&
    typeof record.kind === "string" &&
    typeof record.role === "string" &&
    typeof record.mediaType === "string";
}

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);

/** Decodes the JSON-safe media envelope at the Action boundary. */
function actionContentInput(
  value: unknown,
): ContentInput | readonly ContentInput[] {
  const decode = (partValue: unknown): unknown => {
    const part = asRecord(partValue);
    if (typeof part.type !== "string" || !MEDIA_TYPES.has(part.type)) {
      return partValue;
    }
    if (part.bytes instanceof Uint8Array) return partValue;
    const encoded = typeof part.dataBase64 === "string"
      ? {
        bytes: base64ToBytes(part.dataBase64),
        mediaType: typeof part.mediaType === "string"
          ? part.mediaType
          : "application/octet-stream",
      }
      : typeof part.url === "string"
      ? parseDataUrl(part.url)
      : null;
    if (!encoded) return partValue;
    const { dataBase64: _dataBase64, url: _url, ...rest } = part;
    return Object.freeze({
      ...rest,
      bytes: encoded.bytes,
      mediaType: typeof part.mediaType === "string"
        ? part.mediaType
        : encoded.mediaType,
    });
  };
  return (Array.isArray(value)
    ? Object.freeze(value.map(decode))
    : decode(value)) as ContentInput | readonly ContentInput[];
}

export async function prepareActionContent(
  value: unknown,
  context: Pick<ActionContext, "content">,
  operationKey: string,
): Promise<DurableContentInput> {
  if (Array.isArray(value) && value.every(isContentRef)) {
    return Object.freeze(structuredClone(value)) as ContentSequence;
  }
  if (preparedContent(value)) {
    throw new TypeError(
      "PreparedContent cannot cross an Action boundary; pass canonical refs or source content.",
    );
  }
  return await context.content.prepare(
    actionContentInput(value),
    { operationKey },
  );
}

function preparedContent(value: unknown): PreparedContent | undefined {
  return value && typeof value === "object" && !Array.isArray(value) &&
      Array.isArray((value as PreparedContent).content) &&
      Array.isArray((value as PreparedContent).assets)
    ? value as PreparedContent
    : undefined;
}

export function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}
