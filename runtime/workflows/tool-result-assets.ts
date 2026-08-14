import {
  base64ToBytes,
  formatAssetRef,
  parseDataUrl,
} from "../content/index.ts";
import type {
  ContentInput,
  ContentKind,
  PreparedContent,
} from "../content/index.ts";

export type ToolResultAssetErrorCode =
  | "tool_result_asset_invalid"
  | "tool_result_asset_cycle"
  | "tool_result_asset_limit";

export type ToolResultAssetError = Error & {
  code: ToolResultAssetErrorCode;
  path?: string;
};

export type ExtractToolResultAssetsOptions = Readonly<{
  namespace: string;
  threadId: string;
  toolExecutionId: string;
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: { operationKey: string },
  ): Promise<PreparedContent>;
  maxDepth?: number;
  maxAssets?: number;
  maxDecodedBytes?: number;
}>;

export type ExtractedToolResult = Readonly<{
  output: unknown;
  attachments?: PreparedContent;
}>;

type Extraction = {
  key: string;
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
  refIndex: number;
};

type Placeholder = Readonly<{ __copilotzAssetExtraction: number }>;

function error(
  code: ToolResultAssetErrorCode,
  message: string,
  path?: string,
): ToolResultAssetError {
  const value = new Error(message) as ToolResultAssetError;
  value.name = "ToolResultAssetError";
  value.code = code;
  if (path) value.path = path;
  return value;
}

function pointer(parent: string, segment: string | number): string {
  const encoded = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${encoded}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function kindFor(mediaType: string): ContentKind {
  const type = mediaType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/")) return "text";
  if (type === "application/json" || type.includes("+json")) return "json";
  return "file";
}

function descriptor(
  namespace: string,
  extraction: Extraction,
  assetId: string,
): Record<string, unknown> {
  return {
    assetRef: formatAssetRef(namespace, assetId),
    kind: kindFor(extraction.mediaType),
    mediaType: extraction.mediaType,
    byteLength: extraction.bytes.byteLength,
    ...(extraction.name ? { name: extraction.name } : {}),
  };
}

function malformed(path: string): never {
  throw error(
    "tool_result_asset_invalid",
    `Tool result contains malformed encoded asset data at '${path || "/"}'.`,
    path || "/",
  );
}

/** Extracts nested encoded bodies before live output, persistence, and LLM reuse. */
export async function extractToolResultAssets(
  value: unknown,
  options: ExtractToolResultAssetsOptions,
): Promise<ExtractedToolResult> {
  const maxDepth = options.maxDepth ?? 32;
  const maxAssets = options.maxAssets ?? 32;
  const maxDecodedBytes = options.maxDecodedBytes ?? 32 * 1024 * 1024;
  const extractions: Extraction[] = [];
  const byEncodedBody = new Map<string, Extraction>();
  const ancestors = new WeakSet<object>();
  let decodedBytes = 0;

  const add = (
    key: string,
    path: string,
    bytes: Uint8Array,
    mediaType: string,
    name?: string,
  ): Placeholder => {
    let extraction = byEncodedBody.get(key);
    if (!extraction) {
      if (extractions.length >= maxAssets) {
        throw error(
          "tool_result_asset_limit",
          `Tool result exceeds ${maxAssets} extracted assets.`,
          path,
        );
      }
      decodedBytes += bytes.byteLength;
      if (decodedBytes > maxDecodedBytes) {
        throw error(
          "tool_result_asset_limit",
          `Tool result exceeds ${maxDecodedBytes} decoded asset bytes.`,
          path,
        );
      }
      extraction = {
        key,
        path,
        bytes,
        mediaType,
        name,
        refIndex: extractions.length,
      };
      extractions.push(extraction);
      byEncodedBody.set(key, extraction);
    }
    return Object.freeze({ __copilotzAssetExtraction: extraction.refIndex });
  };

  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (depth > maxDepth) {
      throw error(
        "tool_result_asset_limit",
        `Tool result exceeds traversal depth ${maxDepth}.`,
        path,
      );
    }
    if (typeof current === "string") {
      if (!current.startsWith("data:")) return current;
      const parsed = parseDataUrl(current);
      if (!parsed) return malformed(path);
      return add(current, path, parsed.bytes, parsed.mediaType);
    }
    if (!current || typeof current !== "object") return current;
    if (!Array.isArray(current) && !plainObject(current)) return current;
    if (ancestors.has(current)) {
      throw error(
        "tool_result_asset_cycle",
        `Tool result contains a cycle at '${path || "/"}'.`,
        path || "/",
      );
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) =>
          visit(item, pointer(path, index), depth + 1)
        );
      }
      const source = current as Record<string, unknown>;
      if (typeof source.dataUrl === "string") {
        const parsed = parseDataUrl(source.dataUrl);
        if (!parsed) return malformed(pointer(path, "dataUrl"));
        const name = typeof source.name === "string"
          ? source.name
          : typeof source.fileName === "string"
          ? source.fileName
          : undefined;
        const marker = add(
          source.dataUrl,
          pointer(path, "dataUrl"),
          parsed.bytes,
          parsed.mediaType,
          name,
        );
        const surrounding = Object.fromEntries(
          Object.entries(source).filter(([key]) =>
            key !== "dataUrl" && key !== "dataBase64" && key !== "mimeType" &&
            key !== "fileName" && key !== "name"
          )
            .map((
              [key, nested],
            ) => [key, visit(nested, pointer(path, key), depth + 1)]),
        );
        return {
          ...surrounding,
          ...marker,
          ...(name ? { __copilotzAssetName: name } : {}),
        };
      }
      if (
        typeof source.mimeType === "string" &&
        typeof source.dataBase64 === "string"
      ) {
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(source.dataBase64);
        } catch {
          return malformed(pointer(path, "dataBase64"));
        }
        const mediaType = source.mimeType.trim();
        if (!mediaType) return malformed(pointer(path, "mimeType"));
        const name = typeof source.name === "string"
          ? source.name
          : typeof source.fileName === "string"
          ? source.fileName
          : undefined;
        const marker = add(
          `${mediaType};base64,${source.dataBase64}`,
          pointer(path, "dataBase64"),
          bytes,
          mediaType,
          name,
        );
        const surrounding = Object.fromEntries(
          Object.entries(source).filter(([key]) =>
            key !== "dataBase64" && key !== "mimeType" && key !== "fileName" &&
            key !== "name"
          )
            .map((
              [key, nested],
            ) => [key, visit(nested, pointer(path, key), depth + 1)]),
        );
        return {
          ...surrounding,
          ...marker,
          ...(name ? { __copilotzAssetName: name } : {}),
        };
      }
      return Object.fromEntries(
        Object.entries(source).map(([key, nested]) => [
          key,
          visit(nested, pointer(path, key), depth + 1),
        ]),
      );
    } finally {
      ancestors.delete(current);
    }
  };

  const staged = visit(value, "", 0);
  if (extractions.length === 0) return Object.freeze({ output: staged });
  const attachments = await options.prepare(
    extractions.map((item) => ({
      type: kindFor(item.mediaType) === "image"
        ? "image" as const
        : kindFor(item.mediaType) === "audio"
        ? "audio" as const
        : kindFor(item.mediaType) === "video"
        ? "video" as const
        : "file" as const,
      bytes: item.bytes,
      mediaType: item.mediaType,
      role: "attachment",
      ...(item.name ? { name: item.name } : {}),
      origin: {
        scope: { type: "thread" as const, id: options.threadId },
        producer: { type: "tool_execution", id: options.toolExecutionId },
        path: item.path || "/",
      },
    })),
    { operationKey: "tool:extracted-assets" },
  );
  const replace = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(replace);
    if (!plainObject(current)) return current;
    if (typeof current.__copilotzAssetExtraction === "number") {
      const index = current.__copilotzAssetExtraction;
      const extraction = extractions[index];
      const ref = attachments.content[index];
      const surrounding = Object.fromEntries(
        Object.entries(current).filter(([key]) =>
          key !== "__copilotzAssetExtraction" && key !== "__copilotzAssetName"
        ).map(([key, nested]) => [key, replace(nested)]),
      );
      return {
        ...surrounding,
        ...descriptor(options.namespace, extraction, ref.assetId),
        ...(typeof current.__copilotzAssetName === "string"
          ? { name: current.__copilotzAssetName }
          : {}),
      };
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, nested]) => [key, replace(nested)]),
    );
  };
  return Object.freeze({ output: replace(staged), attachments });
}
