/**
 * A request as the web host hands it to a route's Action (its `httpRequest`
 * schema, in hosts/web/routes.ts, which plugins can't import yet), and the
 * answer it takes back. The body is text, or base64 when it isn't
 * (`base64: true`).
 */
import type { Infer } from "../../../../runtime/mod.ts";

export const httpRequest = {
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string" },
    query: { type: "object", additionalProperties: { type: "string" } },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "string" },
    base64: { type: "boolean", const: true },
  },
  required: ["method", "path", "query", "headers"],
  additionalProperties: false,
} as const;

export type HttpRequest = Infer<typeof httpRequest>;

export type HttpAnswer = { status?: number; headers?: Record<string, string>; body?: unknown };

/** A request's body, as the bytes that were sent (what a signature covers). */
export function bytesOf(request: HttpRequest): Uint8Array {
  if (request.body === undefined) return new Uint8Array();
  if (!request.base64) return new TextEncoder().encode(request.body);
  const binary = atob(request.body);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
