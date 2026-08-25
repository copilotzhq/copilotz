/** Builds portable Knowledge source-loading declarations. @module */
import { parseDocumentToText } from "./internal/document-parser.ts";
import type {
  KnowledgeSourceLoader,
  KnowledgeTextExtractor,
  LoadedKnowledgeSource,
} from "../../internal/types.ts";

const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function htmlText(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

function markdownText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[-*_]{3,}$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
    "application/sql",
  ].includes(mediaType);
}

function inferredUrlTitle(uri: string): string {
  const parsed = new URL(uri);
  return parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
}

/** Portable URL loader. Filesystem paths require an injected adapter. */
export function createDefaultKnowledgeSourceLoader(
  options: Readonly<{
    fetch?: typeof globalThis.fetch;
    maxBytes?: number;
    headers?: Readonly<Record<string, string>>;
  }> = {},
): KnowledgeSourceLoader {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  return async ({ document, signal }): Promise<LoadedKnowledgeSource> => {
    const uri = document.sourceUri?.trim();
    if (!uri) throw new Error(`Document '${document.id}' has no source URI.`);
    if (!/^https?:\/\//i.test(uri)) {
      throw new Error(
        `Filesystem source '${uri}' requires an injected knowledge source loader.`,
      );
    }
    if (typeof fetcher !== "function") {
      throw new Error(
        "This runtime does not provide a Web fetch implementation.",
      );
    }
    const response = await fetcher(uri, {
      signal,
      headers: { "user-agent": "Copilotz-Knowledge/3", ...options.headers },
    });
    if (!response.ok) {
      throw new Error(`Knowledge source returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Knowledge source exceeds ${maxBytes} bytes.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Knowledge source exceeds ${maxBytes} bytes.`);
    }
    const mediaType = response.headers.get("content-type")?.split(";")[0]
      ?.trim() || "text/plain";
    return Object.freeze({
      bytes,
      mediaType,
      sourceType: "url",
      sourceUri: uri,
      title: inferredUrlTitle(uri),
    });
  };
}

/** Portable text/HTML/Markdown/DOCX extractor used by the built-in plugin. */
export function createDefaultKnowledgeTextExtractor(): KnowledgeTextExtractor {
  return async ({ bytes, mediaType, signal }) => {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Extraction cancelled.");
    }
    const normalized = mediaType.split(";")[0].trim().toLowerCase();
    if (isTextMediaType(normalized)) {
      const decoded = new TextDecoder().decode(bytes).replace(/\r\n/g, "\n");
      if (normalized.includes("html")) return htmlText(decoded);
      if (normalized.includes("markdown")) return markdownText(decoded);
      return decoded.trim();
    }
    const parsed = await parseDocumentToText(bytes, normalized, {
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (parsed) return parsed.text.trim();
    throw new Error(
      `No knowledge text extractor supports media type '${normalized}'.`,
    );
  };
}
