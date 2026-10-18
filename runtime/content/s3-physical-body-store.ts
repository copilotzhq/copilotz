/** Private owner-managed physical copies. No leases, adoption, cleanup or catalog. */
import type { S3BodyStorageConfig } from "./body-store.ts";
import { createContentError } from "./errors.ts";
import { digestContent } from "./digest.ts";
import {
  capturePhysicalAppend,
  capturePhysicalIdentity,
  capturePhysicalRange,
  OWNER_PHYSICAL_BODY_FORMAT,
  PHYSICAL_APPEND_MAX_BYTES,
  type PhysicalAppend,
  type PhysicalBodyHead,
  type PhysicalBodyStore,
  physicalIdentifier,
  type PhysicalWriterIdentity,
  samePhysicalWriter,
} from "./physical-body-store.ts";
import { OWNER_PHYSICAL_OBJECT_ROOT } from "./physical-object-namespace.ts";
import {
  checkPhysicalObjectGrowth,
  decodePhysicalObjectManifest,
  encodePhysicalObjectManifest,
  PHYSICAL_MANIFEST_DECODE_BYTES,
  type PhysicalObjectGrowthLimits,
  physicalObjectGrowthLimits,
  type PhysicalObjectManifest,
  type PhysicalObjectPart,
} from "./physical-object-manifest.ts";
import { createPhysicalS3Requester } from "./physical-s3-request.ts";
import { parseStrongEtag } from "./s3-transport.ts";

type Stored = Readonly<{ manifest: PhysicalObjectManifest; version: string }>;
const encoder = new TextEncoder();
function conflict(): never {
  throw createContentError(
    "asset_conflict",
    "Physical reservation, generation, state or append identity conflicts.",
  );
}
function unavailable(): never {
  throw createContentError(
    "asset_storage_unavailable",
    "Physical object response or bytes are unavailable.",
  );
}
const hash = async (parts: readonly unknown[]) =>
  (await digestContent(encoder.encode(JSON.stringify(parts)))).slice(7);
export function createS3PhysicalBodyStore(
  config: S3BodyStorageConfig,
  input: Readonly<{ scope: string } & Partial<PhysicalObjectGrowthLimits>>,
): PhysicalBodyStore {
  const scope = physicalIdentifier(input.scope);
  const limits = physicalObjectGrowthLimits(input);
  const send = createPhysicalS3Requester(config);
  // Owner scope is stable across host epochs. Legacy config.prefix/protectionMs
  // have no lifetime or location meaning in this separate reserved format.
  const base = async (bodyId: string) =>
    `${OWNER_PHYSICAL_OBJECT_ROOT}${await hash([scope, bodyId])}`;
  const metadataKey = async (bodyId: string) =>
    `${await base(bodyId)}/manifest.json`;
  const partKey = async (
    manifest: PhysicalObjectManifest,
    part: PhysicalObjectPart,
  ) =>
    `${await base(manifest.identity.bodyId)}/parts/${await hash([
      manifest.identity,
      part.appendId,
      part.offset,
      part.length,
      part.digest,
    ])}`;
  const head = ({ manifest, version }: Stored): PhysicalBodyHead =>
    Object.freeze({
      ...manifest.identity,
      generation: manifest.identity.generation +
        (manifest.state === "fenced" ? 1 : 0),
      format: OWNER_PHYSICAL_BODY_FORMAT,
      state: manifest.state,
      byteLength: manifest.byteLength,
      versionToken: version,
    });
  async function read(bodyId: string): Promise<Stored | null> {
    const objectName = await metadataKey(bodyId);
    const inspected = await send({
      method: "HEAD",
      objectName,
      maxResponseBytes: 0,
    });
    if (inspected.status === 404) return null;
    if (inspected.status !== 200) unavailable();
    const version = parseStrongEtag(inspected.headers.get("etag"));
    if (!version) unavailable();
    // Bind the bytes to the inspected version, even when a runtime omits GET ETag.
    const response = await send({
      method: "GET",
      objectName,
      headers: { "if-match": version },
      maxResponseBytes: PHYSICAL_MANIFEST_DECODE_BYTES,
    });
    if (response.status === 412 || response.status === 409) conflict();
    if (response.status !== 200) unavailable();
    const returned = response.headers.get("etag");
    if (returned !== null && parseStrongEtag(returned) !== version) {
      unavailable();
    }
    return {
      manifest: decodePhysicalObjectManifest(response.bytes, scope, bodyId),
      version,
    };
  }
  const fresh = (
    identity: PhysicalWriterIdentity,
    state: "open" | "fenced",
  ): PhysicalObjectManifest => ({
    format: OWNER_PHYSICAL_BODY_FORMAT,
    scope,
    identity,
    state,
    byteLength: 0,
    parts: [],
  });
  async function write(
    manifest: PhysicalObjectManifest,
    previous: string | null,
    bytes: Uint8Array,
  ): Promise<void> {
    const response = await send({
      method: "PUT",
      objectName: await metadataKey(manifest.identity.bodyId),
      body: bytes,
      headers: {
        "content-type": "application/json",
        ...(previous === null
          ? { "if-none-match": "*" }
          : { "if-match": previous }),
      },
      maxResponseBytes: 64 * 1024,
    });
    if ([409, 412].includes(response.status)) return;
    if (![200, 201, 204].includes(response.status)) unavailable();
  }
  function exact(
    stored: Stored | null,
    writer: PhysicalWriterIdentity,
    open: boolean,
  ): Stored {
    if (
      !stored || !samePhysicalWriter(stored.manifest.identity, writer) ||
      (open && stored.manifest.state !== "open")
    ) conflict();
    return stored;
  }
  async function readPart(
    manifest: PhysicalObjectManifest,
    part: PhysicalObjectPart,
  ): Promise<Uint8Array> {
    const response = await send({
      method: "GET",
      objectName: await partKey(manifest, part),
      maxResponseBytes: PHYSICAL_APPEND_MAX_BYTES,
    });
    if (
      response.status !== 200 || response.bytes.byteLength !== part.length ||
      await digestContent(response.bytes) !== part.digest
    ) unavailable();
    return response.bytes;
  }
  async function replay(
    stored: Stored,
    request: PhysicalAppend,
    digest: string,
  ): Promise<boolean> {
    const part = stored.manifest.parts.find((part) =>
      part.appendId === request.appendId
    );
    if (!part) return false;
    if (
      part.offset !== request.expectedOffset ||
      part.length !== request.bytes.byteLength || part.digest !== digest
    ) conflict();
    const retained = await readPart(stored.manifest, part);
    if (!retained.every((byte, index) => byte === request.bytes[index])) {
      conflict();
    }
    return true;
  }
  return Object.freeze(
    {
      async reserve(value) {
        const identity = capturePhysicalIdentity(value);
        let stored = await read(identity.bodyId);
        if (stored) return head(exact(stored, identity, true));
        const manifest = fresh(identity, "open");
        await write(
          manifest,
          null,
          checkPhysicalObjectGrowth(manifest, limits),
        );
        stored = await read(identity.bodyId);
        return head(exact(stored, identity, true));
      },
      async append(value) {
        const request = capturePhysicalAppend(value);
        const digest = await digestContent(request.bytes);
        let stored = exact(
          await read(request.writer.bodyId),
          request.writer,
          true,
        );
        if (!await replay(stored, request, digest)) {
          if (request.expectedOffset !== stored.manifest.byteLength) conflict();
          const part: PhysicalObjectPart = {
            appendId: request.appendId,
            offset: request.expectedOffset,
            length: request.bytes.byteLength,
            digest,
          };
          const manifest: PhysicalObjectManifest = {
            ...stored.manifest,
            byteLength: request.expectedOffset + request.bytes.byteLength,
            parts: [...stored.manifest.parts, part],
          };
          // Count escaped UTF-8 metadata before uploading any new part.
          const metadata = checkPhysicalObjectGrowth(manifest, limits);
          const uploaded = await send({
            method: "PUT",
            objectName: await partKey(manifest, part),
            headers: { "if-none-match": "*" },
            body: request.bytes,
            maxResponseBytes: 64 * 1024,
          });
          if ([409, 412].includes(uploaded.status)) {
            const retained = await readPart(manifest, part);
            if (
              !retained.every((byte, index) => byte === request.bytes[index])
            ) conflict();
          } else if (![200, 201, 204].includes(uploaded.status)) unavailable();
          // Never delete a speculative part: a concurrent identical retry may own it.
          await write(manifest, stored.version, metadata);
          stored = exact(
            await read(request.writer.bodyId),
            request.writer,
            true,
          );
          if (!await replay(stored, request, digest)) conflict();
        }
        return Object.freeze({
          startOffset: request.expectedOffset,
          endOffset: stored.manifest.byteLength,
          versionToken: stored.version,
        });
      },
      async fence(value) {
        const identity = capturePhysicalIdentity(value);
        let stored = await read(identity.bodyId);
        if (stored) {
          stored = exact(stored, identity, false);
          if (stored.manifest.state === "fenced") return head(stored);
        }
        const manifest = stored
          ? { ...stored.manifest, state: "fenced" as const }
          : fresh(identity, "fenced");
        const bytes = encodePhysicalObjectManifest(manifest);
        if (bytes.byteLength > PHYSICAL_MANIFEST_DECODE_BYTES) unavailable();
        await write(manifest, stored?.version ?? null, bytes);
        stored = exact(await read(identity.bodyId), identity, false);
        if (stored.manifest.state !== "fenced") conflict();
        return head(stored);
      },
      async head(value) {
        const stored = await read(physicalIdentifier(value));
        return stored ? head(stored) : null;
      },
      async readRange(value) {
        const request = capturePhysicalRange(value);
        const stored = await read(request.bodyId);
        if (!stored) {
          throw createContentError(
            "asset_not_found",
            "Physical copy does not exist.",
          );
        }
        if (request.end > stored.manifest.byteLength) unavailable();
        if (request.end === request.offset) return new Uint8Array();
        const result = new Uint8Array(request.end - request.offset);
        let copied = 0;
        for (const part of stored.manifest.parts) {
          const end = part.offset + part.length;
          if (end <= request.offset || part.offset >= request.end) continue;
          const bytes = await readPart(stored.manifest, part);
          const selected = bytes.subarray(
            Math.max(request.offset - part.offset, 0),
            Math.min(request.end - part.offset, part.length),
          );
          result.set(selected, copied);
          copied += selected.byteLength;
        }
        if (copied !== result.byteLength) unavailable();
        return result;
      },
    } satisfies PhysicalBodyStore,
  );
}
