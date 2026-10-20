/** Shared physical transitions. Drivers own only bytes and exact compare-and-swap. */
import type {
  AppendBodyInput,
  BodyState,
  BodyStore,
  BodyStoreKind,
  MutableBodyHead,
  PutBodyInput,
  ReadyBodyHead,
  ReserveBodyInput,
  TerminalBodyHead,
  WriterCapability,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import { sha256 } from "@noble/hashes/sha256";

export const BODY_APPEND_MAX_BYTES = 1024 * 1024;
export const BODY_READ_MAX_BYTES = 1024 * 1024;
export type BodyPart = Readonly<
  {
    appendId: string;
    offset: number;
    length: number;
    digest: `sha256:${string}`;
  }
>;
export type StoredBody = Readonly<{
  bodyId: string;
  mediaType: string;
  reservationId: string;
  generation: number;
  fencedFrom: number | null;
  state: "open" | "ready" | "incomplete" | "aborted";
  byteLength: number;
  digest: `sha256:${string}` | null;
  revision: number;
  /** Makes every replacement distinct, even when all other fields match. */
  nonce: string;
  updatedAt: string;
  parts: readonly BodyPart[];
}>;
export type StoredVersion = Readonly<
  { body: StoredBody; versionToken: string }
>;
export type PartWrite = Readonly<{ part: BodyPart; bytes: Uint8Array }>;
export type BodyDriver = Readonly<{
  kind: BodyStoreKind;
  backendId: string;
  conditionalDelete: boolean;
  load(bodyId: string): Promise<StoredVersion | null>;
  compareAndSwap(
    body: StoredBody,
    previous: string | null,
    writes: readonly PartWrite[],
  ): Promise<string | false>;
  readRange(
    stored: StoredVersion,
    start: number,
    end: number,
  ): Promise<Uint8Array>;
  list(
    input: { prefix: string; after: string; limit: number },
  ): Promise<readonly StoredVersion[]>;
  delete(stored: StoredVersion): Promise<boolean>;
  resumeDelete?(bodyId: string, versionToken: string): Promise<boolean>;
}>;
export function bodyConflict(
  message =
    "Physical reservation, generation, state or append identity conflicts.",
): never {
  throw createContentError("asset_conflict", message);
}
export function invalidBodyRequest(): never {
  throw createContentError("content_invalid", "Invalid physical body request.");
}
export function bodyUnavailable(
  message = "Physical body bytes are unavailable.",
): never {
  throw createContentError("asset_corrupted", message);
}
export function bodyIdentifier(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024 || /[\r\n]/.test(value)
  ) invalidBodyRequest();
  return value;
}
export function bodyInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) invalidBodyRequest();
  return value;
}
function data(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalidBodyRequest();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidBodyRequest();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some((key) =>
      typeof key !== "string" || ![...required, ...optional].includes(key)
    )
  ) invalidBodyRequest();
  const result: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (required.includes(key)) invalidBodyRequest();
      continue;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalidBodyRequest();
    }
    result[key] = descriptor.value;
  }
  return result;
}
export function captureBodyIdentity(
  input: unknown,
  writer = false,
): ReserveBodyInput {
  const value = data(input, [
    "bodyId",
    "mediaType",
    "reservationId",
    "generation",
  ], writer ? ["byteLength", "discarded"] : []);
  return Object.freeze({
    bodyId: bodyIdentifier(value.bodyId),
    mediaType: bodyIdentifier(value.mediaType),
    reservationId: bodyIdentifier(value.reservationId),
    generation: bodyInteger(
      value.generation,
      1,
      Number.MAX_SAFE_INTEGER - (writer ? 0 : 1),
    ),
  });
}
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
function ownedBytes(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): Uint8Array {
  if (!(value instanceof Uint8Array)) invalidBodyRequest();
  const size = typedArrayLength.call(value);
  if (!Number.isSafeInteger(size) || size > maximum) invalidBodyRequest();
  // Avoid overridable .slice(), iterator and property access on a subclass.
  const buffer = new Uint8Array(size);
  Uint8Array.prototype.set.call(buffer, value);
  return buffer;
}
export function captureBodyAppend(input: unknown): AppendBodyInput {
  const value = data(input, ["writer", "expectedOffset", "appendId", "bytes"]);
  const bytes = ownedBytes(value.bytes, BODY_APPEND_MAX_BYTES);
  if (!bytes.length) invalidBodyRequest();
  const expectedOffset = bodyInteger(value.expectedOffset);
  bodyInteger(expectedOffset + bytes.length);
  const identity = captureBodyIdentity(value.writer, true);
  return Object.freeze({
    writer: { ...identity, byteLength: 0, discarded: 0 },
    expectedOffset,
    appendId: bodyIdentifier(value.appendId),
    bytes,
  });
}
export function captureBodyRange(
  input: unknown,
): { bodyId: string; offset: number; end: number } {
  const value = data(input, ["bodyId", "offset", "end"]);
  const offset = bodyInteger(value.offset), end = bodyInteger(value.end);
  if (end < offset || end - offset > BODY_READ_MAX_BYTES) invalidBodyRequest();
  return { bodyId: bodyIdentifier(value.bodyId), offset, end };
}
function digestValue(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    invalidBodyRequest();
  }
  return value as `sha256:${string}`;
}
export function captureBodyPut(input: unknown): PutBodyInput {
  const value = data(input, ["bodyId", "bytes", "mediaType", "digest"], [
    "ifAbsent",
  ]);
  if (value.ifAbsent !== undefined && typeof value.ifAbsent !== "boolean") {
    invalidBodyRequest();
  }
  return {
    bodyId: bodyIdentifier(value.bodyId),
    bytes: ownedBytes(value.bytes),
    mediaType: bodyIdentifier(value.mediaType),
    digest: digestValue(value.digest),
  };
}
export function bodyHead(
  stored: StoredVersion,
): TerminalBodyHead | MutableBodyHead {
  const { body, versionToken } = stored;
  const common = {
    bodyId: body.bodyId,
    mediaType: body.mediaType,
    byteLength: body.byteLength,
    maintenanceVersion: body.revision,
    versionToken,
    lastModified: body.updatedAt,
  };
  if (body.state === "ready" || body.state === "incomplete") {
    if (!body.digest) bodyUnavailable();
    return Object.freeze({
      ...common,
      state: body.state,
      digest: body.digest,
      etag: versionToken,
    });
  }
  if (body.state === "aborted") {
    return Object.freeze({
      ...common,
      state: "aborted",
      discarded: 0,
      reservationId: body.reservationId,
    });
  }
  return Object.freeze({
    ...common,
    state: "open",
    discarded: 0,
    reservationId: body.reservationId,
    writerGeneration: body.generation,
  });
}
function capability(body: StoredBody): WriterCapability {
  return Object.freeze({
    bodyId: body.bodyId,
    mediaType: body.mediaType,
    reservationId: body.reservationId,
    generation: body.generation,
    byteLength: body.byteLength,
    discarded: 0,
  });
}
function matches(body: StoredBody, identity: ReserveBodyInput): boolean {
  return body.bodyId === identity.bodyId &&
    body.mediaType === identity.mediaType &&
    body.reservationId === identity.reservationId &&
    body.generation === identity.generation;
}
function fresh(identity: ReserveBodyInput): StoredBody {
  return {
    ...identity,
    fencedFrom: null,
    state: "open",
    byteLength: 0,
    digest: null,
    revision: 1,
    nonce: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    parts: [],
  };
}
function changed(body: StoredBody, patch: Partial<StoredBody>): StoredBody {
  return {
    ...body,
    ...patch,
    revision: body.revision + 1,
    nonce: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
}
function requireWriter(
  stored: StoredVersion | null,
  identity: ReserveBodyInput,
  writable = false,
): StoredVersion {
  if (
    !stored || !matches(stored.body, identity) ||
    (writable &&
      (stored.body.state !== "open" || stored.body.fencedFrom !== null))
  ) bodyConflict();
  return stored;
}
async function exactRange(
  driver: BodyDriver,
  stored: StoredVersion,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const bytes = await driver.readRange(stored, start, end);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== end - start) {
    bodyUnavailable(
      "Physical body prefix is missing, overlapping or truncated.",
    );
  }
  return bytes;
}
/** Internal implementation of the one BodyStore contract; not a second storage API. */
export function createBodyStoreOperations(driver: BodyDriver): BodyStore {
  const required = async (bodyId: string): Promise<StoredVersion> => {
    const stored = await driver.load(bodyIdentifier(bodyId));
    if (!stored || stored.body.state === "aborted") {
      throw createContentError(
        "asset_not_found",
        "Physical body was not found.",
      );
    }
    return stored;
  };
  const stream = (
    stored: StoredVersion,
    offset: number,
  ): ReadableStream<Uint8Array> => {
    let cursor = offset;
    return new ReadableStream({
      async pull(controller) {
        if (cursor >= stored.body.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(
          stored.body.byteLength,
          cursor + BODY_READ_MAX_BYTES,
        );
        controller.enqueue(await exactRange(driver, stored, cursor, end));
        cursor = end;
      },
    });
  };
  async function settle(
    input: unknown,
    state: "ready" | "incomplete",
  ): Promise<TerminalBodyHead> {
    const value = data(input, [
      "writer",
      "expectedByteLength",
      "expectedDigest",
    ]);
    const identity = captureBodyIdentity(value.writer, true),
      length = bodyInteger(value.expectedByteLength),
      digest = digestValue(value.expectedDigest);
    const stored = requireWriter(await driver.load(identity.bodyId), identity);
    const body = stored.body;
    if (
      body.state === state && body.byteLength === length &&
      body.digest === digest
    ) return bodyHead(stored) as TerminalBodyHead;
    if (
      body.state !== "open" ||
      length > body.byteLength ||
      // F9 §3.3: the owner may finish its durable seal intent after revocation.
      // Only the advanced fenced identity can certify a shorter ready prefix.
      (state === "ready" && body.fencedFrom === null &&
        length !== body.byteLength)
    ) bodyConflict();
    const hash = sha256.create();
    for (let start = 0; start < length;) {
      const end = Math.min(length, start + BODY_READ_MAX_BYTES);
      hash.update(await exactRange(driver, stored, start, end));
      start = end;
    }
    if (
      `sha256:${
        Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0"))
          .join("")
      }` !== digest
    ) {
      bodyConflict("Physical body digest does not match the accepted prefix.");
    }
    const next = changed(body, { state, byteLength: length, digest });
    await driver.compareAndSwap(next, stored.versionToken, []);
    const current = requireWriter(await driver.load(identity.bodyId), identity);
    if (
      current.body.state !== state || current.body.byteLength !== length ||
      current.body.digest !== digest
    ) bodyConflict();
    return bodyHead(current) as TerminalBodyHead;
  }
  return {
    kind: driver.kind,
    backendId: driver.backendId,
    conditionalDelete: driver.conditionalDelete,
    async put(raw) {
      const input = captureBodyPut(raw);
      if (await digestContent(input.bytes) !== input.digest) {
        bodyUnavailable("Input bytes do not match the declared body digest.");
      }
      let stored = await driver.load(input.bodyId);
      if (!stored) {
        const writes: PartWrite[] = [];
        for (
          let offset = 0;
          offset < input.bytes.length;
          offset += BODY_APPEND_MAX_BYTES
        ) {
          const bytes = input.bytes.slice(
            offset,
            offset + BODY_APPEND_MAX_BYTES,
          );
          writes.push({
            part: {
              appendId: `put:${offset}`,
              offset,
              length: bytes.length,
              digest: await digestContent(bytes),
            },
            bytes,
          });
        }
        const body: StoredBody = {
          ...fresh({
            bodyId: input.bodyId,
            mediaType: input.mediaType,
            reservationId: `put:${crypto.randomUUID()}`,
            generation: 1,
          }),
          state: "ready",
          digest: input.digest,
          byteLength: input.bytes.length,
          parts: writes.map((x) => x.part),
        };
        const versionToken = await driver.compareAndSwap(body, null, writes);
        if (versionToken) {
          return bodyHead({ body, versionToken }) as ReadyBodyHead;
        }
        stored = await driver.load(input.bodyId);
      }
      if (
        !stored || stored.body.state !== "ready" ||
        stored.body.byteLength !== input.bytes.length ||
        stored.body.mediaType !== input.mediaType ||
        stored.body.digest !== input.digest
      ) bodyConflict();
      // Verify retained bytes as well as metadata before reporting an exact immutable retry.
      for (let start = 0; start < input.bytes.length;) {
        const end = Math.min(input.bytes.length, start + BODY_READ_MAX_BYTES),
          bytes = await exactRange(driver, stored, start, end);
        if (
          !bytes.every((byte, index) => byte === input.bytes[start + index])
        ) bodyConflict();
        start = end;
      }
      return bodyHead(stored) as ReadyBodyHead;
    },
    async head({ bodyId }) {
      const stored = await driver.load(bodyIdentifier(bodyId));
      return stored ? bodyHead(stored) : null;
    },
    async headReady({ bodyId }) {
      const stored = await driver.load(bodyIdentifier(bodyId));
      return stored?.body.state === "ready"
        ? bodyHead(stored) as ReadyBodyHead
        : null;
    },
    async read({ bodyId }) {
      return stream(await required(bodyId), 0);
    },
    async readRange(raw) {
      const input = captureBodyRange(raw),
        stored = await required(input.bodyId);
      const end = Math.min(input.end, stored.body.byteLength);
      return end <= input.offset
        ? new Uint8Array()
        : await exactRange(driver, stored, input.offset, end);
    },
    async follow({ bodyId, offset = 0 }) {
      bodyInteger(offset);
      return stream(await required(bodyId), offset);
    },
    async reserve(raw) {
      const identity = captureBodyIdentity(raw);
      let stored = await driver.load(identity.bodyId);
      if (!stored) {
        await driver.compareAndSwap(fresh(identity), null, []);
        stored = await driver.load(identity.bodyId);
      }
      return capability(requireWriter(stored, identity, true).body);
    },
    async fence(raw) {
      const value = data(raw, ["writer"]),
        identity = captureBodyIdentity(value.writer, true);
      bodyInteger(identity.generation + 1, 1);
      let stored = await driver.load(identity.bodyId);
      const exactFence = (current: StoredVersion | null) =>
        current && current.body.bodyId === identity.bodyId &&
        current.body.mediaType === identity.mediaType &&
        current.body.reservationId === identity.reservationId &&
        current.body.fencedFrom === identity.generation &&
        current.body.generation === identity.generation + 1;
      if (exactFence(stored)) return capability(stored!.body);
      if (stored) {
        requireWriter(stored, identity);
        if (stored.body.fencedFrom !== null) bodyConflict();
      }
      const next = changed(stored?.body ?? fresh(identity), {
        generation: identity.generation + 1,
        fencedFrom: identity.generation,
      });
      await driver.compareAndSwap(next, stored?.versionToken ?? null, []);
      stored = await driver.load(identity.bodyId);
      if (!exactFence(stored)) bodyConflict();
      return capability(stored!.body);
    },
    async append(raw) {
      const input = captureBodyAppend(raw),
        digest = await digestContent(input.bytes);
      let stored = requireWriter(
        await driver.load(input.writer.bodyId),
        input.writer,
        true,
      );
      const replay = async (value: StoredVersion): Promise<boolean> => {
        const part = value.body.parts.find((p) =>
          p.appendId === input.appendId
        );
        if (!part) return false;
        if (
          part.offset !== input.expectedOffset ||
          part.length !== input.bytes.length || part.digest !== digest
        ) bodyConflict();
        const bytes = await exactRange(
          driver,
          value,
          part.offset,
          part.offset + part.length,
        );
        if (!bytes.every((byte, index) => byte === input.bytes[index])) {
          bodyConflict();
        }
        return true;
      };
      if (!await replay(stored)) {
        if (stored.body.byteLength !== input.expectedOffset) bodyConflict();
        const part: BodyPart = {
          appendId: input.appendId,
          offset: input.expectedOffset,
          length: input.bytes.length,
          digest,
        };
        const body = changed(stored.body, {
          byteLength: input.expectedOffset + input.bytes.length,
          parts: [...stored.body.parts, part],
        });
        const versionToken = await driver.compareAndSwap(
          body,
          stored.versionToken,
          [{ part, bytes: input.bytes }],
        );
        if (versionToken) {
          return Object.freeze({
            startOffset: input.expectedOffset,
            endOffset: body.byteLength,
            versionToken,
          });
        }
        stored = requireWriter(
          await driver.load(input.writer.bodyId),
          input.writer,
          true,
        );
        if (!await replay(stored)) bodyConflict();
      }
      return Object.freeze({
        startOffset: input.expectedOffset,
        endOffset: input.expectedOffset + input.bytes.length,
        versionToken: stored.versionToken,
      });
    },
    async seal(input) {
      return await settle(input, "ready") as ReadyBodyHead;
    },
    async terminate(input) {
      return await settle(input, "incomplete") as TerminalBodyHead & {
        state: "incomplete";
      };
    },
    async abort(raw) {
      const value = data(raw, ["writer"]),
        identity = captureBodyIdentity(value.writer, true);
      const stored = requireWriter(
        await driver.load(identity.bodyId),
        identity,
      );
      if (stored.body.state === "aborted") return;
      if (stored.body.state !== "open") bodyConflict();
      if (
        !await driver.compareAndSwap(
          changed(stored.body, { state: "aborted" }),
          stored.versionToken,
          [],
        )
      ) bodyConflict();
    },
    maintenance: {
      async list(input) {
        bodyInteger(input.limit, 1);
        bodyInteger(input.idleForMs);
        const values = await driver.list({
          prefix: input.prefix ?? "",
          after: input.after ?? "",
          limit: input.limit,
        });
        const states = new Set<BodyState>(input.states),
          cutoff = Date.now() - input.idleForMs;
        const bodies = values.filter((v) =>
          states.has(v.body.state) && Date.parse(v.body.updatedAt) <= cutoff
        ).map(bodyHead);
        return {
          bodies,
          ...(values.length === input.limit
            ? { after: values[values.length - 1].body.bodyId }
            : {}),
        };
      },
      async delete(input) {
        bodyIdentifier(input.bodyId);
        bodyIdentifier(input.expectedVersionToken);
        if (!driver.conditionalDelete) return false;
        const stored = await driver.load(input.bodyId);
        if (!stored) {
          return await driver.resumeDelete?.(
            input.bodyId,
            input.expectedVersionToken,
          ) ?? false;
        }
        if (
          stored.versionToken !== input.expectedVersionToken ||
          stored.body.state !== input.expectedState
        ) {
          return await driver.resumeDelete?.(
            input.bodyId,
            input.expectedVersionToken,
          ) ?? false;
        }
        return await driver.delete(stored);
      },
    },
  };
}

export function createMemoryOperations(backendId: string): BodyStore {
  const records = new Map<string, StoredVersion>();
  const bytes = new Map<string, Map<string, Uint8Array>>();
  return createBodyStoreOperations({
    kind: "memory",
    backendId,
    conditionalDelete: true,
    load(bodyId) {
      return Promise.resolve(records.get(bodyId) ?? null);
    },
    compareAndSwap(body, previous, writes) {
      if ((records.get(body.bodyId)?.versionToken ?? null) !== previous) {
        return Promise.resolve(false);
      }
      const parts = bytes.get(body.bodyId) ?? new Map<string, Uint8Array>();
      for (const write of writes) {
        parts.set(write.part.appendId, write.bytes.slice());
      }
      bytes.set(body.bodyId, parts);
      records.set(body.bodyId, { body, versionToken: body.nonce });
      return Promise.resolve(body.nonce);
    },
    readRange(stored, start, end) {
      const output = new Uint8Array(end - start);
      let copied = 0;
      const current = records.get(stored.body.bodyId)?.body;
      if (
        !current || current.reservationId !== stored.body.reservationId ||
        (current.fencedFrom ?? current.generation) !==
          (stored.body.fencedFrom ?? stored.body.generation) ||
        current.state === "aborted" || current.byteLength < end
      ) bodyConflict();
      for (const part of stored.body.parts) {
        if (part.offset >= end || part.offset + part.length <= start) continue;
        const chunk = bytes.get(stored.body.bodyId)?.get(part.appendId);
        if (!chunk || chunk.length !== part.length) bodyUnavailable();
        const slice = chunk.subarray(
          Math.max(0, start - part.offset),
          Math.min(part.length, end - part.offset),
        );
        output.set(slice, copied);
        copied += slice.length;
      }
      if (copied !== output.length) bodyUnavailable();
      return Promise.resolve(output);
    },
    list(input) {
      return Promise.resolve(
        [...records.values()].filter((v) =>
          v.body.bodyId.startsWith(input.prefix) && v.body.bodyId > input.after
        ).sort((a, b) => a.body.bodyId.localeCompare(b.body.bodyId)).slice(
          0,
          input.limit,
        ),
      );
    },
    delete(stored) {
      if (
        records.get(stored.body.bodyId)?.versionToken !== stored.versionToken
      ) return Promise.resolve(false);
      records.delete(stored.body.bodyId);
      bytes.delete(stored.body.bodyId);
      return Promise.resolve(true);
    },
  });
}
