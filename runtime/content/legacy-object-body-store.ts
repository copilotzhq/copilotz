/** Read-only access to absolute object names from the pre-manifest layout. */
import type {
  BodyReader,
  BodyStore,
  ReadyBodyHead,
  S3BodyStorageConfig,
} from "./body-store.ts";
import {
  BODY_READ_MAX_BYTES,
  bodyIdentifier,
  bodyInteger,
  captureBodyRange,
} from "./body-store-operations.ts";
import { createS3Requester } from "./s3-request.ts";
import { createLegacyS3Source } from "./s3-legacy-source.ts";
import { digestContent } from "./digest.ts";

const legacyStores = new WeakSet<BodyStore>();
/** Internal dispatch for the offline owner-key storage resolver. */
export function isLegacyObjectBodyStore(store: BodyStore): boolean {
  return legacyStores.has(store);
}
function invalid(message: string): never {
  throw new Error(`Legacy object body: ${message}`);
}

/** No prefix is applied. Keep writers stopped for the entire offline cutover. */
export function createLegacyObjectBodyStore(
  config: S3BodyStorageConfig,
  options: Readonly<
    {
      fetch?: typeof fetch;
      timeoutMs?: number;
      readRetries?: number;
      retryDelayMs?: number;
    }
  > = {},
): BodyStore {
  const source = createLegacyS3Source(
    config,
    createS3Requester(config, options),
    invalid,
  );
  // Pin observations for this cutover session, including across separate range calls.
  const versions = new Map<string, string>();
  async function head(
    { bodyId }: { bodyId: string },
  ): Promise<ReadyBodyHead | null> {
    bodyIdentifier(bodyId);
    const observed = await source.inspect(bodyId);
    if (!observed) {
      if (await source.inspect(`${bodyId}.progressive/meta.json`)) {
        invalid(
          "progressive legacy bodies (including incomplete) are unsupported; resolve the retained prefix before cutover",
        );
      }
      return null;
    }
    const headers = observed.response.headers;
    const metadata = (name: string) =>
      headers.get(`x-goog-meta-copilotz-${name}`) ??
        headers.get(`x-amz-meta-copilotz-${name}`);
    const digest = metadata("sha256")?.replace(/^sha256:/, "");
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) {
      invalid(
        "missing or invalid copilotz-sha256 metadata; an exact stored SHA-256 is required",
      );
    }
    const mediaType = metadata("media-type") ?? headers.get("content-type");
    if (!mediaType?.trim()) invalid("missing source media type");
    const previous = versions.get(bodyId);
    if (previous !== undefined && previous !== observed.version) {
      invalid("source version changed since its first observation");
    }
    versions.set(bodyId, observed.version);
    return Object.freeze({
      bodyId,
      state: "ready",
      byteLength: observed.length,
      digest: `sha256:${digest}`,
      mediaType,
      maintenanceVersion: bodyInteger(
        Number(metadata("maintenance-version") ?? 1),
        1,
      ),
      versionToken: observed.version,
    });
  }
  const required = async (bodyId: string) =>
    await head({ bodyId }) ?? invalid("source object is missing");
  const range = (value: ReadyBodyHead, offset: number, end: number) =>
    source.read(
      value.bodyId,
      value.versionToken,
      offset,
      end,
      value.byteLength,
    );
  async function follow(
    { bodyId, offset = 0 }: { bodyId: string; offset?: number },
  ) {
    bodyInteger(offset);
    const value = await required(bodyId);
    let cursor = offset;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cursor >= value.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(value.byteLength, cursor + BODY_READ_MAX_BYTES);
        controller.enqueue(await range(value, cursor, end));
        cursor = end;
      },
    }, { highWaterMark: 0 });
  }
  const refuse = () =>
    invalid("read-only store; mutations and maintenance are forbidden");
  const store: BodyStore = {
    kind: "object",
    backendId: bodyIdentifier(config.backendId),
    conditionalDelete: false,
    head,
    headReady: head,
    read: follow,
    follow,
    async readRange(input) {
      const { bodyId, offset, end } = captureBodyRange(input);
      const value = await required(bodyId);
      return offset >= value.byteLength
        ? new Uint8Array()
        : await range(value, offset, Math.min(end, value.byteLength));
    },
    put: refuse,
    reserve: refuse,
    fence: refuse,
    append: refuse,
    seal: refuse,
    terminate: refuse,
    abort: refuse,
    maintenance: { list: refuse, delete: refuse },
  };
  legacyStores.add(store);
  return Object.freeze(store);
}

/** BodyReader for owner-key/tenancy transfer: verify the entire retained object. */
export function legacyObjectBodyReader(store: BodyStore): BodyReader {
  return async (copy) => {
    if (copy.backendId !== store.backendId) invalid("wrong migration backend");
    const head = await store.head({ bodyId: copy.key });
    if (!head) invalid("source object is missing");
    if (head.state !== "ready") {
      invalid("only terminal ready objects are supported");
    }
    if (head.byteLength !== copy.length) {
      invalid("retained length differs from source object length");
    }
    const bytes = new Uint8Array(head.byteLength);
    for (let offset = 0; offset < bytes.length;) {
      const end = Math.min(bytes.length, offset + BODY_READ_MAX_BYTES);
      const chunk = await store.readRange({ bodyId: copy.key, offset, end });
      if (chunk.length !== end - offset) {
        invalid("source returned a short range");
      }
      bytes.set(chunk, offset);
      offset = end;
    }
    if (await digestContent(bytes) !== head.digest) {
      invalid("source digest mismatch");
    }
    return { bytes, mediaType: head.mediaType };
  };
}
