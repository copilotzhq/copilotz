import {
  objectBodyBase,
  objectBodyRoot,
  objectOwnerSegment,
} from "./object-owner-prefix.ts";
import type { BodyStore, S3BodyStorageConfig } from "./body-store.ts";
import {
  BODY_APPEND_MAX_BYTES,
  bodyConflict,
  type BodyPart,
  bodyUnavailable,
  createBodyStoreOperations,
  type StoredBody,
  type StoredVersion,
} from "./body-store-operations.ts";
import {
  BODY_MANIFEST_DECODE_BYTES,
  type BodyObjectLimits,
  bodyObjectLimits,
  checkBodyObjectGrowth,
  decodeBodyObjectManifest,
  encodeBodyObjectManifest,
} from "./body-object-manifest.ts";
import { createS3Requester, type S3Response } from "./s3-request.ts";
import { parseStrongEtag } from "./s3-transport.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";

export function s3BodyStoreReadyGarbageCollection(
  config: S3BodyStorageConfig,
): boolean {
  if (
    config.provider !== undefined && config.provider !== "s3" &&
    config.provider !== "gcs"
  ) throw new TypeError("S3 provider must be either 's3' or 'gcs'.");
  return config.provider === "gcs";
}
function positiveGeneration(value: string | null): string | undefined {
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  return BigInt(value) <= 18446744073709551615n ? value : undefined;
}
function unavailable(): never {
  throw createContentError(
    "asset_storage_unavailable",
    "S3 body response or conditional version is unavailable.",
  );
}
function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) =>
      match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll(
        "&quot;",
        '"',
      ).replaceAll("&apos;", "'").replaceAll("&amp;", "&")
    );
}
/** The sole S3-compatible adapter. Immutable parts are shared safely by exact retries. */
export function createS3BodyStore(
  config: S3BodyStorageConfig,
  options: Readonly<
    Partial<BodyObjectLimits> & { fetch?: typeof fetch; timeoutMs?: number }
  > = {},
): BodyStore {
  const backendId = config.backendId.trim();
  if (!backendId) throw new TypeError("S3 backendId must be non-empty.");
  const conditionalDelete = s3BodyStoreReadyGarbageCollection(config),
    limits = bodyObjectLimits(options),
    send = createS3Requester(config, options);
  const encoder = new TextEncoder(),
    hash = async (value: unknown) =>
      (await digestContent(encoder.encode(JSON.stringify(value)))).slice(7);
  const root = objectBodyRoot(config.prefix ?? "");
  const base = (bodyId: string) => objectBodyBase(config.prefix ?? "", bodyId);
  const metadataKey = async (bodyId: string) =>
    `${await base(bodyId)}/manifest.json`;
  const partKey = async (body: StoredBody, part: BodyPart) =>
    `${await base(body.bodyId)}/parts/${await hash([
      body.reservationId,
      body.fencedFrom ?? body.generation,
      part,
    ])}`;
  const version = (response: S3Response): string => {
    if (conditionalDelete) {
      const generation = positiveGeneration(
          response.headers.get("x-goog-generation"),
        ),
        meta = positiveGeneration(
          response.headers.get("x-goog-metageneration"),
        );
      if (!generation || !meta) unavailable();
      return `${generation}:${meta}`;
    }
    return parseStrongEtag(response.headers.get("etag")) ?? unavailable();
  };
  const guard = (token: string | null): Record<string, string> => {
    if (conditionalDelete) {
      if (token === null) return { "x-goog-if-generation-match": "0" };
      const [generation, meta, ...rest] = token.split(":");
      if (
        rest.length || !positiveGeneration(generation) ||
        !positiveGeneration(meta)
      ) unavailable();
      return {
        "x-goog-if-generation-match": generation,
        "x-goog-if-metageneration-match": meta,
      };
    }
    return token === null ? { "if-none-match": "*" } : { "if-match": token };
  };
  async function readMetadata(
    objectName: string,
  ): Promise<{ bytes: Uint8Array; versionToken: string } | null> {
    const response = await send({
      method: "GET",
      objectName,
      maxResponseBytes: BODY_MANIFEST_DECODE_BYTES,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) unavailable();
    return { bytes: response.bytes, versionToken: version(response) };
  }

  async function* objectKeys(prefix: string): AsyncGenerator<string> {
    let continuation: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await send({
        method: "GET",
        objectName: "",
        query: {
          "list-type": "2",
          prefix,
          "max-keys": "500",
          ...(continuation ? { "continuation-token": continuation } : {}),
        },
        maxResponseBytes: BODY_MANIFEST_DECODE_BYTES,
      });
      if (response.status !== 200) unavailable();
      const xml = new TextDecoder().decode(response.bytes);
      for (const key of xmlValues(xml, "Key")) {
        if (!key.startsWith(prefix)) unavailable();
        yield key;
      }
      const truncated = xmlValues(xml, "IsTruncated")[0] === "true";
      continuation = truncated
        ? xmlValues(xml, "NextContinuationToken")[0]
        : undefined;
      if (truncated && (!continuation || seen.has(continuation))) unavailable();
      if (continuation) seen.add(continuation);
    } while (continuation);
  }
  async function hasRetiredParts(bodyId: string): Promise<boolean> {
    for await (const _key of objectKeys(`${await base(bodyId)}/parts/`)) {
      return true;
    }
    return false;
  }
  type Retirement = {
    bodyId: string;
    sourceVersionToken: string;
    body: StoredBody | null;
    complete: boolean;
  };
  function retirement(bytes: Uint8Array): Retirement | null {
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      bodyUnavailable("Invalid body metadata.");
    }
    if (!value || typeof value !== "object" || !("retired" in value)) {
      return null;
    }
    const record = value.retired;
    if (
      Object.keys(value).length !== 1 || !record ||
      typeof record.bodyId !== "string" ||
      typeof record.sourceVersionToken !== "string" ||
      typeof record.complete !== "boolean" ||
      Object.keys(record).sort().join(",") !==
        "body,bodyId,complete,sourceVersionToken"
    ) bodyUnavailable("Invalid physical retirement tombstone.");
    if (record.complete) { if (record.body !== null) bodyUnavailable(); }
    else {record.body = decodeBodyObjectManifest(
        encoder.encode(JSON.stringify(record.body)),
        record.bodyId,
      );}
    return record;
  }
  async function loadKey(
    objectName: string,
    bodyId?: string,
  ): Promise<StoredVersion | null> {
    const raw = await readMetadata(objectName);
    if (!raw) return null;
    const retired = retirement(raw.bytes);
    if (retired) {
      if (
        (bodyId !== undefined && retired.bodyId !== bodyId) ||
        objectName !== await metadataKey(retired.bodyId)
      ) bodyUnavailable();
      // A completed tombstone remains discoverable when an already dispatched
      // upload arrives later. It can never become a readable/reservable copy.
      if (retired.complete && !await hasRetiredParts(retired.bodyId)) {
        return null;
      }
      return {
        body: {
          bodyId: retired.bodyId,
          mediaType: "application/octet-stream",
          generation: 1,
          fencedFrom: null,
          byteLength: 0,
          parts: [],
          updatedAt: "1970-01-01T00:00:00.000Z",
          nonce: raw.versionToken,
          ...retired.body,
          state: "aborted",
          digest: null,
          reservationId: `retired:${await hash(retired.sourceVersionToken)}`,
          revision: (retired.body?.revision ?? 0) + 1,
        },
        versionToken: raw.versionToken,
      };
    }
    const body = decodeBodyObjectManifest(raw.bytes, bodyId);
    if (objectName !== await metadataKey(body.bodyId)) {
      bodyUnavailable("Object key does not match the body identity.");
    }
    return { body, versionToken: raw.versionToken };
  }
  async function resumeDelete(
    bodyId: string,
    sourceVersionToken: string,
  ): Promise<boolean> {
    if (!conditionalDelete) return false;
    const objectName = await metadataKey(bodyId),
      raw = await readMetadata(objectName);
    if (!raw) return false;
    const record = retirement(raw.bytes);
    if (
      !record || record.bodyId !== bodyId ||
      (record.sourceVersionToken !== sourceVersionToken &&
        raw.versionToken !== sourceVersionToken)
    ) return false;
    // Once the body namespace is irreversibly retired, every part in it is
    // unreachable. This includes speculative losing appends absent from the
    // committed manifest. Never perform this sweep for an active body.
    for await (const key of objectKeys(`${await base(bodyId)}/parts/`)) {
      const inspected = await send({
        method: "HEAD",
        objectName: key,
        maxResponseBytes: 0,
      });
      if (inspected.status === 404) continue;
      if (inspected.status !== 200) unavailable();
      const removed = await send({
        method: "DELETE",
        objectName: key,
        headers: guard(version(inspected)),
        maxResponseBytes: 64 * 1024,
      });
      if (![200, 202, 204, 404].includes(removed.status)) unavailable();
    }
    if (record.complete) return true;
    const response = await send({
      method: "PUT",
      objectName,
      headers: {
        "content-type": "application/json",
        ...guard(raw.versionToken),
      },
      body: encoder.encode(
        JSON.stringify({ retired: { ...record, body: null, complete: true } }),
      ),
      maxResponseBytes: 64 * 1024,
    });
    if (![200, 201, 204, 409, 412].includes(response.status)) unavailable();
    if ([409, 412].includes(response.status)) {
      const latest = await readMetadata(objectName),
        current = latest && retirement(latest.bytes);
      return !!current && current.bodyId === bodyId &&
        current.sourceVersionToken === record.sourceVersionToken &&
        current.complete;
    }
    return true;
  }
  async function readPart(
    body: StoredBody,
    part: BodyPart,
  ): Promise<Uint8Array> {
    const response = await send({
      method: "GET",
      objectName: await partKey(body, part),
      maxResponseBytes: BODY_APPEND_MAX_BYTES,
    });
    if (
      response.status !== 200 || response.bytes.length !== part.length ||
      await digestContent(response.bytes) !== part.digest
    ) bodyUnavailable("Immutable body part is missing or corrupted.");
    return response.bytes;
  }
  return createBodyStoreOperations({
    kind: "object",
    backendId,
    conditionalDelete,
    async load(bodyId) {
      return await loadKey(await metadataKey(bodyId), bodyId);
    },
    async compareAndSwap(body, previous, writes) {
      // Growth is checked before any part upload. Terminal/fence transitions must
      // remain possible even when a reopened store uses a lower growth budget.
      const metadata =
        writes.length || previous === null && body.fencedFrom === null
          ? checkBodyObjectGrowth(body, limits)
          : encodeBodyObjectManifest(body);
      if (metadata.length > BODY_MANIFEST_DECODE_BYTES) unavailable();
      for (const write of writes) {
        const response = await send({
          method: "PUT",
          objectName: await partKey(body, write.part),
          headers: guard(null),
          body: write.bytes,
          maxResponseBytes: 64 * 1024,
        });
        if ([409, 412].includes(response.status)) {
          const retained = await readPart(body, write.part);
          if (
            !retained.every((byte, index) => byte === write.bytes[index])
          ) bodyConflict();
        } else if (![200, 201, 204].includes(response.status)) unavailable();
      }
      const response = await send({
        method: "PUT",
        objectName: await metadataKey(body.bodyId),
        headers: { "content-type": "application/json", ...guard(previous) },
        body: metadata,
        maxResponseBytes: 64 * 1024,
      });
      // A losing request never deletes parts: an identical winner may reference them.
      if ([409, 412].includes(response.status)) return false;
      if (![200, 201, 204].includes(response.status)) unavailable();
      return version(response);
    },
    async readRange(stored, start, end) {
      const output = new Uint8Array(end - start);
      let copied = 0;
      for (const part of stored.body.parts) {
        if (part.offset >= end || part.offset + part.length <= start) continue;
        const bytes = await readPart(stored.body, part),
          slice = bytes.subarray(
            Math.max(0, start - part.offset),
            Math.min(part.length, end - part.offset),
          );
        output.set(slice, copied);
        copied += slice.length;
      }
      if (copied !== output.length) bodyUnavailable();
      return output;
    },
    async list(input) {
      const candidates: StoredVersion[] = [];
      for await (
        const key of objectKeys(
          `${await root}${
            objectOwnerSegment(input.prefix) === "unscoped/"
              ? ""
              : objectOwnerSegment(input.prefix)
          }`,
        )
      ) {
        if (!key.endsWith("/manifest.json")) continue;
        const stored = await loadKey(key);
        if (
          !stored || !stored.body.bodyId.startsWith(input.prefix) ||
          stored.body.bodyId <= input.after
        ) continue;
        candidates.push(stored);
        candidates.sort((a, b) => a.body.bodyId.localeCompare(b.body.bodyId));
        if (candidates.length > input.limit) candidates.pop();
      }
      return candidates;
    },
    async delete(stored) {
      if (!conditionalDelete) return false;
      const current = await readMetadata(await metadataKey(stored.body.bodyId));
      if (current && retirement(current.bytes)) {
        return await resumeDelete(stored.body.bodyId, stored.versionToken);
      }
      // Retain a tiny irreversible tombstone at the manifest key. It prevents
      // delayed reserve/append requests from resurrecting a collected copy, and
      // carries the exact part list until generation-bound cleanup completes.
      const marker = encoder.encode(
        JSON.stringify({
          retired: {
            bodyId: stored.body.bodyId,
            sourceVersionToken: stored.versionToken,
            body: stored.body,
            complete: false,
          },
        }),
      );
      if (marker.length > BODY_MANIFEST_DECODE_BYTES) unavailable();
      const response = await send({
        method: "PUT",
        objectName: await metadataKey(stored.body.bodyId),
        headers: {
          "content-type": "application/json",
          ...guard(stored.versionToken),
        },
        body: marker,
        maxResponseBytes: 64 * 1024,
      });
      if ([409, 412].includes(response.status)) {
        return await resumeDelete(stored.body.bodyId, stored.versionToken);
      }
      if (![200, 201, 204].includes(response.status)) unavailable();
      return await resumeDelete(stored.body.bodyId, stored.versionToken);
    },
    resumeDelete,
  });
}
