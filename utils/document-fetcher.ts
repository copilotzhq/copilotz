/**
 * Document Fetcher Utility
 * 
 * Fetches document content from various sources:
 * - URLs (http/https)
 * - Local files
 * - Raw text (text: prefix)
 */

export interface FetchedDocument {
  content: string;
  mimeType: string;
  sourceType: "url" | "file" | "text";
  sourceUri: string | null;
  title: string | null;
  size: number;
}

export interface FetchOptions {
  timeout?: number;
  maxSize?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Fetch document content from a source string
 * 
 * @param source - URL, file path, or text content (prefixed with "text:")
 * @param options - Fetch options
 * @returns Fetched document with content and metadata
 */
export async function fetchDocument(
  source: string,
  options: FetchOptions = {},
): Promise<FetchedDocument> {
  const { timeout = DEFAULT_TIMEOUT, maxSize = DEFAULT_MAX_SIZE } = options;

  // Handle raw text
  if (source.startsWith("text:")) {
    const content = source.slice(5);
    return {
      content,
      mimeType: "text/plain",
      sourceType: "text",
      sourceUri: null,
      title: null,
      size: content.length,
    };
  }

  // Handle URLs
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return await fetchFromUrl(source, { timeout, maxSize, headers: options.headers });
  }

  // Handle file paths
  return await fetchFromFile(source, { maxSize });
}

/**
 * Fetch document from URL
 */
async function fetchFromUrl(
  url: string,
  options: { timeout: number; maxSize: number; headers?: Record<string, string> },
): Promise<FetchedDocument> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Copilotz-RAG/1.0",
        ...options.headers,
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content length
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > options.maxSize) {
      throw new Error(`Document too large: ${contentLength} bytes (max: ${options.maxSize})`);
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0] || "text/plain";
    
    // Only handle text-based content for now
    if (!isTextMimeType(mimeType)) {
      throw new Error(`Unsupported content type: ${mimeType}. Only text-based documents are supported.`);
    }

    const content = await response.text();

    if (content.length > options.maxSize) {
      throw new Error(`Document too large: ${content.length} bytes (max: ${options.maxSize})`);
    }

    // Extract title from URL
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const title = pathParts[pathParts.length - 1] || parsedUrl.hostname;

    return {
      content,
      mimeType,
      sourceType: "url",
      sourceUri: url,
      title,
      size: content.length,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === "AbortError") {
      throw new Error(`Request timeout after ${options.timeout}ms`);
    }
    throw error;
  }
}

/**
 * Fetch document from local file
 */
async function fetchFromFile(
  filePath: string,
  options: { maxSize: number },
): Promise<FetchedDocument> {
  try {
    // Runtime-agnostic file reading
    const anyGlobal = globalThis as unknown as {
      Deno?: {
        readTextFile?: (path: string) => Promise<string>;
        stat?: (path: string) => Promise<{ size: number }>;
      };
    };

    if (anyGlobal.Deno?.readTextFile && anyGlobal.Deno?.stat) {
      // Deno runtime
      const stat = await anyGlobal.Deno.stat(filePath);
      if (stat.size > options.maxSize) {
        throw new Error(`File too large: ${stat.size} bytes (max: ${options.maxSize})`);
      }

      const content = await anyGlobal.Deno.readTextFile(filePath);
      const mimeType = getMimeTypeFromPath(filePath);
      const title = filePath.split("/").pop() || filePath;

      return {
        content,
        mimeType,
        sourceType: "file",
        sourceUri: filePath,
        title,
        size: content.length,
      };
    }

    // Node.js runtime (dynamic import)
    try {
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(filePath);
      if (stat.size > options.maxSize) {
        throw new Error(`File too large: ${stat.size} bytes (max: ${options.maxSize})`);
      }

      const content = await fs.readFile(filePath, "utf-8");
      const mimeType = getMimeTypeFromPath(filePath);
      const title = filePath.split("/").pop() || filePath;

      return {
        content,
        mimeType,
        sourceType: "file",
        sourceUri: filePath,
        title,
        size: content.length,
      };
    } catch {
      throw new Error(`File reading not supported in this runtime`);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Check if MIME type is text-based
 */
function isTextMimeType(mimeType: string): boolean {
  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
    "application/sql",
  ];
  
  return textTypes.some((type) => mimeType.startsWith(type) || mimeType === type);
}

/**
 * Get MIME type from file path extension
 */
function getMimeTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  
  const mimeTypes: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    jsx: "text/javascript",
    tsx: "text/typescript",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    toml: "application/toml",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    sh: "application/x-sh",
    bash: "application/x-sh",
    sql: "application/sql",
    py: "text/x-python",
    rb: "text/x-ruby",
    go: "text/x-go",
    rs: "text/x-rust",
    java: "text/x-java",
    kt: "text/x-kotlin",
    swift: "text/x-swift",
    c: "text/x-c",
    cpp: "text/x-c++",
    h: "text/x-c",
    hpp: "text/x-c++",
  };

  return mimeTypes[ext || ""] || "text/plain";
}

/**
 * Extract plain text from HTML content
 */
export function extractTextFromHtml(html: string): string {
  // Simple HTML to text conversion
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Replace block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

/**
 * Extract plain text from Markdown content
 */
export function extractTextFromMarkdown(markdown: string): string {
  return markdown
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    // Convert links to text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove headers markers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove emphasis markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, "")
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // Clean up whitespace
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

/**
 * Preprocess document content based on MIME type
 */
export function preprocessContent(content: string, mimeType: string): string {
  if (mimeType.includes("html")) {
    return extractTextFromHtml(content);
  }
  
  if (mimeType.includes("markdown")) {
    return extractTextFromMarkdown(content);
  }
  
  // For other text types, just clean up whitespace
  return content.replace(/\r\n/g, "\n").trim();
}

