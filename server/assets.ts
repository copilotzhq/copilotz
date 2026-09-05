import type { AssetRecord } from "../runtime/content/index.ts";

/** Safe transport metadata. Physical body locations remain server-private. */
export type PublicAsset = Omit<AssetRecord, "location">;

export function publicAsset(asset: AssetRecord): PublicAsset {
  const { location: _location, ...safe } = asset;
  return Object.freeze(structuredClone(safe));
}

import { type ContentRef, formatAssetRef } from "../runtime/content/index.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { ServerEndpointDescriptor } from "../plugins/server/internal/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";
function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function header(
  headers: HttpRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return undefined;
}

function uploadTooLarge(maxBytes: number): Error {
  return appError(
    413,
    "asset_too_large",
    `Asset upload exceeds the ${maxBytes}-byte limit.`,
  );
}

/** Reject a declared oversized upload before Fetch consumes its request body. */
export function assertUploadContentLength(
  request: Request,
  endpoint: ServerEndpointDescriptor,
  maxBytes: number,
): void {
  if (endpoint.kind !== "asset" || endpoint.operation !== "upload") return;
  const contentLength = request.headers.get("content-length")?.trim();
  if (!contentLength || !/^\d+$/.test(contentLength)) return;
  const byteLength = Number(contentLength);
  if (Number.isSafeInteger(byteLength) && byteLength > maxBytes) {
    throw uploadTooLarge(maxBytes);
  }
}

function uploadMediaType(headers: HttpRequest["headers"]): string {
  const mediaType = header(headers, "content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  return mediaType || "application/octet-stream";
}

function uploadFilename(
  headers: HttpRequest["headers"],
): string | undefined {
  const disposition = header(headers, "content-disposition");
  if (!disposition) return undefined;
  const extended = /(?:^|;)\s*filename\*=\s*([^;]+)/i.exec(disposition)?.[1];
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i
    .exec(disposition);
  let value = extended ?? plain?.[1] ?? plain?.[2];
  if (!value) return undefined;
  value = value.trim().replace(/^"|"$/g, "");
  if (extended) {
    value = value.replace(/^utf-8''/i, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  const filename = [...value.replace(/[\\/]/g, "/").split("/").at(-1)!]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    }).join("").trim().slice(0, 255);
  return filename || undefined;
}

export async function assetUploadResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: HttpRequest,
  context: FacadeContext,
  maxBytes: number,
): Promise<HttpResponse> {
  if (endpoint.operation !== "upload") {
    throw appError(405, "method_not_allowed", "Asset method is not allowed.");
  }
  const rawBody = (request.context as { rawBody?: unknown } | undefined)
    ?.rawBody;
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0) {
    throw appError(400, "asset_body_required", "Asset upload requires a body.");
  }
  if (rawBody.byteLength > maxBytes) throw uploadTooLarge(maxBytes);
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) {
    throw appError(400, "namespace_required", "Tenant namespace is required.");
  }
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const name = uploadFilename(request.headers);
  const asset = await scope.content.assets.publish({
    namespace,
    mediaType: uploadMediaType(request.headers),
    body: rawBody,
    idempotencyKey: header(request.headers, "idempotency-key") ??
      crypto.randomUUID(),
    ...(name ? { metadata: { name } } : {}),
  });
  const canonicalName = typeof asset.metadata?.name === "string"
    ? asset.metadata.name
    : undefined;
  const content: ContentRef = Object.freeze({
    assetId: asset.id,
    kind: "file",
    role: "attachment",
    mediaType: asset.mediaType,
    disposition: "attachment",
    ...(canonicalName ? { name: canonicalName } : {}),
  });
  return {
    status: 201,
    data: Object.freeze({
      asset: publicAsset(asset),
      assetRef: formatAssetRef(namespace, asset.id),
      content,
    }),
  };
}
