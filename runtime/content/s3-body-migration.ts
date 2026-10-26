/** Explicit offline importer. Never used by a BodyStore operation or runtime activation. */
import { sha256 } from "@noble/hashes/sha256";
import type {
  S3BodyStorageConfig,
  TerminalBodyHead,
  WriterCapability,
} from "./body-store.ts";
import {
  BODY_APPEND_MAX_BYTES,
  BODY_READ_MAX_BYTES,
  bodyIdentifier,
  bodyInteger,
} from "./body-store-operations.ts";
import { createS3BodyStore } from "./s3-body-store.ts";
import { createS3Requester } from "./s3-request.ts";
import { createLegacyS3Source } from "./s3-legacy-source.ts";
import { digestContent } from "./digest.ts";
export type S3BodyImport = Readonly<{
  sourceBodyId: string;
  targetBodyId: string;
  state: "ready" | "incomplete";
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  /** Bind a previously reviewed source version when available. */
  sourceVersionToken?: string;
}>;
export type S3BodyImportResult = Readonly<{
  sourceBodyId: string;
  targetBodyId: string;
  sourceVersionToken: string;
  head: TerminalBodyHead;
}>;
type SourcePart = { key: string; offset: number; length: number };
function invalid(message: string): never {
  throw new Error(`Offline S3 import: ${message}`);
}
/** Copies only explicitly listed, reviewed terminal bodies. Leaves every source object intact. */
export async function importS3BodyCopies(
  config: S3BodyStorageConfig,
  input: Readonly<{ drained: true; copies: readonly S3BodyImport[] }>,
  options: Readonly<{ fetch?: typeof fetch; timeoutMs?: number }> = {},
): Promise<readonly S3BodyImportResult[]> {
  if (input.drained !== true) invalid("drain writers before importing");
  const copies = input.copies.map((copy) => {
    bodyIdentifier(copy.sourceBodyId);
    bodyIdentifier(copy.targetBodyId);
    bodyIdentifier(copy.mediaType);
    bodyInteger(copy.byteLength);
    if (
      !["ready", "incomplete"].includes(copy.state) ||
      !/^sha256:[0-9a-f]{64}$/.test(copy.digest) ||
      copy.sourceBodyId === copy.targetBodyId
    ) invalid("a distinct target key and exact terminal metadata are required");
    return Object.freeze({ ...copy });
  });
  if (new Set(copies.map((copy) => copy.targetBodyId)).size !== copies.length) {
    invalid("target keys must be unique");
  }
  const send = createS3Requester(config, options),
    target = createS3BodyStore(config, options),
    results: S3BodyImportResult[] = [];
  const { token, guard, read, inspect: inspectSource } = createLegacyS3Source(
    config,
    send,
    invalid,
  );
  const inspect = async (key: string) =>
    await inspectSource(key) ??
      invalid("source object is missing or unavailable");
  for (const copy of copies) {
    const sourceKey = copy.state === "ready"
        ? copy.sourceBodyId
        : `${copy.sourceBodyId}.progressive/meta.json`,
      source = await inspect(sourceKey);
    if (
      copy.sourceVersionToken !== undefined &&
      copy.sourceVersionToken !== source.version
    ) invalid("reviewed source version changed");
    let parts: SourcePart[];
    if (copy.state === "ready") {
      const headers = source.response.headers,
        storedDigest = headers.get("x-goog-meta-copilotz-sha256") ??
          headers.get("x-amz-meta-copilotz-sha256"),
        mediaType = headers.get("content-type");
      if (
        source.length !== copy.byteLength || mediaType !== copy.mediaType ||
        storedDigest?.replace(/^sha256:/, "") !== copy.digest.slice(7)
      ) invalid("source Ready metadata differs from the reviewed copy");
      parts = [{ key: sourceKey, offset: 0, length: source.length }];
    } else {
      const response = await send({
        method: "GET",
        objectName: sourceKey,
        headers: guard(source.version),
        maxResponseBytes: 4 * 1024 * 1024,
      });
      if (response.status !== 200 || token(response) !== source.version) {
        invalid("source terminal metadata changed");
      }
      const meta = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
      );
      if (
        !meta || meta.state !== "incomplete" ||
        meta.mediaType !== copy.mediaType ||
        meta.byteLength !== copy.byteLength || meta.discarded !== 0 ||
        meta.terminalDigest !== copy.digest || !Array.isArray(meta.parts)
      ) invalid("only drained exact incomplete prefixes can be imported");
      let offset = 0;
      const keys = new Set<string>();
      parts = meta.parts.map((part: Record<string, unknown>) => {
        if (
          !part || typeof part.key !== "string" ||
          !part.key.startsWith(`${copy.sourceBodyId}.progressive/parts/`) ||
          keys.has(part.key) || part.offset !== offset
        ) invalid("source parts are not contiguous and isolated");
        const length = bodyInteger(part.length, 1), start = offset;
        offset = bodyInteger(offset + length);
        keys.add(part.key);
        return { key: part.key, offset: start, length };
      });
      if (offset !== copy.byteLength) {
        invalid("source terminal coverage is incomplete");
      }
    }
    const reservationId = `import:${
      (await digestContent(
        new TextEncoder().encode(JSON.stringify([copy, source.version])),
      )).slice(7)
    }`;
    const existing = await target.head({ bodyId: copy.targetBodyId });
    let writer: WriterCapability | undefined;
    if (existing?.state !== "ready" && existing?.state !== "incomplete") {
      writer = await target.reserve({
        bodyId: copy.targetBodyId,
        mediaType: copy.mediaType,
        reservationId,
        generation: 1,
      });
    } else if (
      existing.state !== copy.state ||
      existing.byteLength !== copy.byteLength ||
      existing.mediaType !== copy.mediaType || existing.digest !== copy.digest
    ) invalid("target conflicts with the reviewed import");
    const hash = sha256.create();
    let targetOffset = 0, buffered = 0, uploaded = 0;
    const pending = new Uint8Array(BODY_APPEND_MAX_BYTES);
    const flush = async () => {
      if (writer && buffered) {
        const bytes = pending.slice(0, buffered);
        await target.append({
          writer,
          expectedOffset: uploaded,
          appendId: `import:${uploaded}`,
          bytes,
        });
        uploaded += buffered;
        buffered = 0;
      }
    };
    for (const part of parts) {
      const observed = part.key === sourceKey
        ? source
        : await inspect(part.key);
      if (observed.length !== part.length) {
        invalid("source part length changed");
      }
      for (let offset = 0; offset < part.length;) {
        const end = Math.min(part.length, offset + BODY_READ_MAX_BYTES),
          bytes = await read(
            part.key,
            observed.version,
            offset,
            end,
            part.length,
          );
        hash.update(bytes);
        if (writer) {
          let position = 0;
          while (position < bytes.length) {
            const count = Math.min(
              pending.length - buffered,
              bytes.length - position,
            );
            pending.set(bytes.subarray(position, position + count), buffered);
            buffered += count;
            position += count;
            if (buffered === pending.length) await flush();
          }
        } else {
          const retained = await target.readRange({
            bodyId: copy.targetBodyId,
            offset: targetOffset,
            end: targetOffset + bytes.length,
          });
          if (
            !retained.every((byte, index) => byte === bytes[index]) ||
            retained.length !== bytes.length
          ) invalid("retained target bytes differ");
        }
        targetOffset += bytes.length;
        offset = end;
      }
    }
    await flush();
    const digest = `sha256:${
      Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    }`;
    if (digest !== copy.digest || targetOffset !== copy.byteLength) {
      invalid("source bytes fail the reviewed integrity digest");
    }
    if ((await inspect(sourceKey)).version !== source.version) {
      invalid("source metadata changed during import");
    }
    const head = writer
      ? await target[copy.state === "ready" ? "seal" : "terminate"]({
        writer,
        expectedByteLength: copy.byteLength,
        expectedDigest: copy.digest,
      })
      : existing as TerminalBodyHead;
    results.push({
      sourceBodyId: copy.sourceBodyId,
      targetBodyId: copy.targetBodyId,
      sourceVersionToken: source.version,
      head,
    });
  }
  return results;
}
