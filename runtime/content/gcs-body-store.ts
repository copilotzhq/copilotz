import { createFixedBodyStoreAdapter } from "./body-store.ts";
import type {
  AbortBodyInput,
  AppendBodyInput,
  AppendResult,
  BodyProtection,
  BodyStore,
  BodyStoreAdapter,
  IncompleteBodyHead,
  PutBodyInput,
  ReadBodyRangeInput,
  ReadyBodyHead,
  RenewBodyInput,
  ReserveBodyInput,
  TerminateBodyInput,
  WriterCapability,
} from "./body-store.ts";
import { createContentError } from "./errors.ts";
import { digestContent } from "./digest.ts";

/** Fetch-native bearer-token configuration for the GCS JSON API. */
export type GcsBodyStoreConfig = Readonly<{
  bucket: string;
  backendId: string;
  prefix?: string;
  getAccessToken?: () => Promise<string>;
  /** Injectable for tests and non-browser Fetch hosts. */
  fetch?: typeof fetch;
}>;

export type GcsBodyStoreOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => number;
  metadataTimeoutMs?: number;
  /** Deadline for each GCS request, including consumption of its response body. */
  requestTimeoutMs?: number;
}>;

type ObjectMetadata = Readonly<{
  name?: unknown;
  size?: unknown;
  generation?: unknown;
  metageneration?: unknown;
  updated?: unknown;
  contentType?: unknown;
  contentEncoding?: unknown;
  metadata?: unknown;
}>;
type Inspection = Readonly<{ head: ReadyBodyHead; generation: string }>;

const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function join(prefix: string | undefined, id: string): string {
  return prefix ? `${prefix.replace(/\/$/, "")}/${id}` : id;
}
function objectUrl(bucket: string, name?: string): URL {
  const root = `https://storage.googleapis.com/storage/v1/b/${
    encodeURIComponent(bucket)
  }/o`;
  return new URL(
    name === undefined ? root : `${root}/${encodeURIComponent(name)}`,
  );
}
function validGeneration(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    return undefined;
  }
  return BigInt(value) <= 18_446_744_073_709_551_615n ? value : undefined;
}
function asSize(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}
function stringMeta(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : undefined;
}
function malformed(): never {
  throw createContentError(
    "asset_corrupted",
    "GCS object metadata is incomplete for a canonical asset body.",
  );
}
function unsupported(): never {
  throw createContentError(
    "asset_conflict",
    "The GCS Ready store does not support progressive bodies; compose it with a staging BodyStore.",
  );
}
function timeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 2_147_483_647
  ) {
    throw new TypeError("GCS timeout must be a positive 32-bit integer.");
  }
  return resolved;
}
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
function verifiedStream(
  stream: ReadableStream<Uint8Array>,
  expected: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expected) {
          controller.error(
            createContentError(
              "asset_corrupted",
              "GCS body response exceeds its declared size.",
            ),
          );
        } else controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) {
          throw createContentError(
            "asset_corrupted",
            "GCS body response has an unexpected length.",
          );
        }
      },
    }),
  );
}

/** Runtime-neutral metadata-service token provider. It never reads credentials from env. */
export function createGcsMetadataAccessTokenProvider(
  options: GcsBodyStoreOptions = {},
): () => Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = timeout(options.metadataTimeoutMs, 5_000);
  let token: string | undefined;
  let expiresAt = 0;
  let pending: Promise<string> | undefined;
  const refresh = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(METADATA_URL, {
        headers: { "metadata-flavor": "Google" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await discard(response);
        throw createContentError(
          "asset_storage_unavailable",
          `GCS metadata token request failed (${response.status}).`,
        );
      }
      const body = await response.json() as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (
        !body || typeof body.access_token !== "string" ||
        !body.access_token.trim() || /\s/.test(body.access_token) ||
        typeof body.expires_in !== "number" ||
        !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
        !Number.isSafeInteger(now() + body.expires_in * 1000)
      ) {
        throw createContentError(
          "asset_storage_unavailable",
          "GCS metadata token response is invalid.",
        );
      }
      token = body.access_token;
      expiresAt = now() + body.expires_in * 1000;
      return token;
    } catch (cause) {
      if ((cause as { name?: string }).name === "AbortError") {
        throw createContentError(
          "asset_storage_unavailable",
          "GCS metadata token request timed out.",
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
  return async () => {
    if (token && now() < expiresAt - 60_000) return token;
    const current = pending ??= refresh();
    try {
      return await current;
    } finally {
      if (pending === current) pending = undefined;
    }
  };
}

export function createGcsBodyStore(
  config: GcsBodyStoreConfig,
  options: GcsBodyStoreOptions = {},
): BodyStore {
  const bucket = config.bucket.trim();
  const backendId = config.backendId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket) || !backendId) {
    throw new TypeError(
      "GCS bucket must be a bucket name and backendId must be non-empty.",
    );
  }
  const requestTimeoutMs = timeout(options.requestTimeoutMs, 30_000);
  const fetcher = options.fetch ?? config.fetch ?? fetch;
  const token = config.getAccessToken ??
    createGcsMetadataAccessTokenProvider({ ...options, fetch: fetcher });
  const key = (bodyId: string) => {
    if (!bodyId || bodyId.includes("\r") || bodyId.includes("\n")) {
      throw new TypeError(
        "GCS bodyId must be non-empty and cannot contain line breaks.",
      );
    }
    return join(config.prefix, bodyId);
  };
  const validateMediaType = (mediaType: string) => {
    if (!mediaType || mediaType.includes("\r") || mediaType.includes("\n")) {
      throw new TypeError(
        "GCS mediaType must be non-empty and cannot contain line breaks.",
      );
    }
  };
  const request = async (url: URL, init: RequestInit = {}) => {
    const accessToken = await token();
    if (
      typeof accessToken !== "string" || !accessToken || /\s/.test(accessToken)
    ) {
      throw createContentError(
        "asset_storage_unavailable",
        "GCS access token is invalid.",
      );
    }
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("accept-encoding", "identity");
    return await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers,
    });
  };
  const inspect = async (bodyId: string): Promise<Inspection | null> => {
    const response = await request(objectUrl(bucket, key(bodyId)));
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    if (!response.ok) {
      await discard(response);
      throw createContentError(
        "asset_storage_unavailable",
        `GCS object metadata request failed (${response.status}).`,
      );
    }
    const meta = await response.json() as ObjectMetadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) malformed();
    const size = asSize(meta.size),
      digest = stringMeta(meta.metadata, "copilotz-sha256");
    const mediaType = stringMeta(meta.metadata, "copilotz-media-type") ??
      (typeof meta.contentType === "string" ? meta.contentType : undefined);
    const maintenanceVersion = Number(
      stringMeta(meta.metadata, "copilotz-maintenance-version") ?? "1",
    );
    const protectedUntil = stringMeta(
      meta.metadata,
      "copilotz-protected-until",
    );
    const generation = validGeneration(meta.generation);
    if (
      meta.name !== key(bodyId) || size === undefined ||
      !/^sha256:[0-9a-f]{64}$/.test(digest ?? "") || !mediaType ||
      /[\r\n]/.test(mediaType) || !Number.isSafeInteger(maintenanceVersion) ||
      maintenanceVersion < 1 || !generation ||
      !validGeneration(meta.metageneration) ||
      (protectedUntil !== undefined &&
        !Number.isFinite(Date.parse(protectedUntil))) ||
      meta.contentEncoding !== undefined
    ) malformed();
    return ({
      generation,
      head: {
        bodyId,
        state: "ready" as const,
        byteLength: size,
        mediaType,
        digest: digest!.toLowerCase() as `sha256:${string}`,
        maintenanceVersion,
        ...(protectedUntil ? { protectedUntil } : {}),
        etag: generation,
        ...(typeof meta.updated === "string" &&
            Number.isFinite(Date.parse(meta.updated))
          ? { lastModified: new Date(meta.updated).toISOString() }
          : {}),
      } as const,
    } as const);
  };
  const validate = (input: PutBodyInput, head: ReadyBodyHead) => {
    if (
      head.bodyId !== input.bodyId ||
      head.byteLength !== input.bytes.byteLength ||
      head.digest !== input.digest || head.mediaType !== input.mediaType
    ) {
      throw createContentError(
        "asset_conflict",
        "Stored GCS object conflicts with canonical asset content.",
      );
    }
  };
  const requiredInspection = async (bodyId: string): Promise<Inspection> => {
    const inspected = await inspect(bodyId);
    if (!inspected) {
      throw createContentError(
        "asset_not_found",
        "GCS asset body was not found.",
      );
    }
    return inspected;
  };
  const mediaStream = async (
    inspected: Inspection,
    offset: number,
    end: number,
  ): Promise<ReadableStream<Uint8Array>> => {
    if (
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(end) ||
      offset < 0 || end < offset
    ) throw new RangeError("Invalid body byte range.");
    const head = inspected.head;
    if (end > head.byteLength) {
      throw new RangeError("Body byte range exceeds its committed length.");
    }
    if (end === offset) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    }
    const url = objectUrl(bucket, key(head.bodyId));
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", inspected.generation);
    const response = await request(url, {
      headers: { range: `bytes=${offset}-${end - 1}` },
    });
    if (response.status === 404) {
      await discard(response);
      throw createContentError(
        "asset_not_found",
        "GCS asset body was not found.",
      );
    }
    if (
      response.status !== 206 || !response.body ||
      response.headers.get("content-range") !==
        `bytes ${offset}-${end - 1}/${head.byteLength}` ||
      response.headers.has("content-encoding")
    ) {
      await discard(response);
      throw createContentError(
        "asset_storage_unavailable",
        `GCS body range read failed (${response.status}).`,
      );
    }
    return verifiedStream(response.body, end - offset);
  };
  const readRange = async (input: ReadBodyRangeInput) => {
    // Preserve finite-range semantics, including existence checks for empty ranges.
    const inspected = await requiredInspection(input.bodyId);
    const stream = await mediaStream(inspected, input.offset, input.end);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const store: BodyStore = {
    kind: "object",
    backendId,
    async put(input) {
      key(input.bodyId);
      validateMediaType(input.mediaType);
      const actual = await digestContent(input.bytes);
      if (actual !== input.digest) {
        throw createContentError(
          "asset_corrupted",
          "Input bytes do not match the declared body digest.",
        );
      }
      if (
        input.protectedUntil !== undefined &&
        !Number.isFinite(Date.parse(input.protectedUntil))
      ) throw new TypeError("GCS protectedUntil must be an ISO timestamp.");
      const boundary = `copilotz-${crypto.randomUUID()}`;
      const payload =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${
          JSON.stringify({
            name: key(input.bodyId),
            contentType: input.mediaType,
            cacheControl: "private, no-store",
            metadata: {
              "copilotz-sha256": input.digest,
              "copilotz-media-type": input.mediaType,
              "copilotz-maintenance-version": "1",
              ...(input.protectedUntil
                ? { "copilotz-protected-until": input.protectedUntil }
                : {}),
            },
          })
        }\r\n--${boundary}\r\nContent-Type: ${input.mediaType}\r\n\r\n`;
      const ending = `\r\n--${boundary}--\r\n`;
      const prefixBytes = new TextEncoder().encode(payload);
      const suffixBytes = new TextEncoder().encode(ending);
      const bytes = new Uint8Array(
        prefixBytes.length + input.bytes.length + suffixBytes.length,
      );
      bytes.set(prefixBytes);
      bytes.set(input.bytes, prefixBytes.length);
      bytes.set(suffixBytes, prefixBytes.length + input.bytes.length);
      const url = new URL(
        `https://storage.googleapis.com/upload/storage/v1/b/${
          encodeURIComponent(bucket)
        }/o`,
      );
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("ifGenerationMatch", "0");
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body: bytes,
      });
      await discard(response);
      if (!response.ok && response.status !== 412 && response.status !== 409) {
        throw createContentError(
          "asset_storage_unavailable",
          `GCS immutable upload failed (${response.status}).`,
        );
      }
      const inspected = await inspect(input.bodyId);
      if (!inspected) {
        throw createContentError(
          "asset_storage_unavailable",
          "GCS upload completed without a readable object.",
        );
      }
      validate(input, inspected.head);
      return inspected.head;
    },
    async head({ bodyId }) {
      return (await inspect(bodyId))?.head ?? null;
    },
    async read({ bodyId }) {
      const inspected = await requiredInspection(bodyId);
      return await mediaStream(inspected, 0, inspected.head.byteLength);
    },
    readRange,
    async follow(input) {
      const inspected = await requiredInspection(input.bodyId);
      return await mediaStream(
        inspected,
        input.offset ?? 0,
        inspected.head.byteLength,
      );
    },
    reserve(_input: ReserveBodyInput): Promise<WriterCapability> {
      unsupported();
    },
    renew(_input: RenewBodyInput): Promise<BodyProtection> {
      unsupported();
    },
    append(_input: AppendBodyInput): Promise<AppendResult> {
      unsupported();
    },
    seal(_input): Promise<ReadyBodyHead> {
      unsupported();
    },
    terminate(_input: TerminateBodyInput): Promise<IncompleteBodyHead> {
      unsupported();
    },
    abort(_input: AbortBodyInput): Promise<void> {
      unsupported();
    },
    maintenance: {
      list() {
        return Promise.resolve({ bodies: [] } as const);
      },
      delete() {
        return Promise.resolve(false);
      },
    } as const,
  };
  return store;
}

/** Cluster-reachable immutable Ready tier. GC stays disabled until full CAS maintenance is added. */
export function createGcsBodyStoreAdapter(
  config: GcsBodyStoreConfig,
  options: GcsBodyStoreOptions = {},
): BodyStoreAdapter {
  return createFixedBodyStoreAdapter(createGcsBodyStore(config, options), {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: 0,
    readyGarbageCollection: false,
  });
}
