import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "../contracts.ts";
import { actionAbortError } from "./abort.ts";

interface HttpRequestParams {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  maxResponseChars?: number;
}

const DEFAULT_MAX_RESPONSE_CHARS = 100_000;
const MAX_RESPONSE_CHARS_LIMIT = 1_000_000;

function clampMaxResponseChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_RESPONSE_CHARS;
  }
  return Math.min(Math.floor(value), MAX_RESPONSE_CHARS_LIMIT);
}

function truncateResponseBody(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
  length: number;
} {
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    length: text.length,
  };
}

export const httpRequestAction = defineAction({
  id: "copilotz.tools.web.http_request",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to make the request to." },
      method: {
        type: "string",
        description: "HTTP method to use.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        default: "GET",
      },
      headers: {
        type: "object",
        description: "HTTP headers to include.",
        default: {},
      },
      body: {
        type: "string",
        description: "Request body (JSON string for JSON APIs).",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds.",
        default: 30,
        minimum: 1,
        maximum: 120,
      },
      maxResponseChars: {
        type: "number",
        description: "Maximum response body characters to return.",
        default: DEFAULT_MAX_RESPONSE_CHARS,
        minimum: 1,
        maximum: MAX_RESPONSE_CHARS_LIMIT,
      },
    },
    required: ["url"],
  },
  execute: async (
    { url, method = "GET", headers = {}, body, timeout = 30, maxResponseChars }:
      HttpRequestParams,
    context: ActionContext,
  ) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let callerCancelled = false;
    let timedOut = false;
    try {
      // Validate URL
      new URL(url);

      // Prepare headers with user agent
      const requestHeaders: Record<string, string> = {
        "User-Agent": "AgentV2/1.0",
        ...headers,
      };

      // Add content type for JSON if body provided and no content type set
      if (body && !requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json";
      }

      // A local controller lets the request share Action cancellation and its
      // own bounded timeout without mutating the caller's signal.
      const controller = new AbortController();
      const abort = () => {
        callerCancelled = true;
        controller.abort();
      };
      context.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () =>
        context.signal.removeEventListener("abort", abort);
      timeoutId = typeof timeout === "number" && timeout > 0
        ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout * 1000)
        : undefined;
      if (context.signal.aborted) abort();

      const startTime = Date.now();
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: method !== "GET" ? body : undefined,
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();
      const maxChars = clampMaxResponseChars(maxResponseChars);
      const truncatedBody = truncateResponseBody(rawText, maxChars);
      let responseBody: unknown = truncatedBody.text;

      if (
        contentType.includes("application/json") && !truncatedBody.truncated
      ) {
        responseBody = JSON.parse(rawText);
      }

      return {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        bodyLength: truncatedBody.length,
        bodyTruncated: truncatedBody.truncated,
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      if (callerCancelled || context.signal.aborted) {
        throw actionAbortError(context.signal);
      }
      if (timedOut || (error as Error).name === "AbortError") {
        throw new Error(`Request timeout after ${timeout} seconds`);
      }
      throw new Error(`HTTP request failed: ${(error as Error).message}`);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      removeAbortListener?.();
    }
  },
});

export const httpRequestTool = defineTool(
  "http_request",
  httpRequestAction,
  {
    name: "HTTP Request",
    description: "Make HTTP requests to external APIs and web services.",
  },
);
