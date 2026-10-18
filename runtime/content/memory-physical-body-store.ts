/** Private fresh memory copies for owner-managed writers; deliberately no maintenance API. */
import { sliceBodyChunks } from "./body-chunks.ts";
import { createContentError } from "./errors.ts";
import {
  capturePhysicalAppend,
  capturePhysicalIdentity,
  capturePhysicalRange,
  OWNER_PHYSICAL_BODY_FORMAT,
  type PhysicalBodyHead,
  type PhysicalBodyStore,
  physicalIdentifier,
  type PhysicalWriterIdentity,
  samePhysicalWriter,
} from "./physical-body-store.ts";

type Copy = {
  identity: PhysicalWriterIdentity;
  state: "open" | "fenced";
  byteLength: number;
  versionToken: string;
  chunks: Uint8Array[];
  appends: Map<string, Readonly<{ offset: number; bytes: Uint8Array }>>;
};
export function createMemoryPhysicalBodyStore(): PhysicalBodyStore {
  const copies = new Map<string, Copy>();
  const storeId = crypto.randomUUID();
  let revision = 0n;
  const version = () => `memory:${storeId}:${++revision}`;
  function conflict(): never {
    throw createContentError(
      "asset_conflict",
      "Physical reservation, generation, state or append identity conflicts.",
    );
  }
  const head = (copy: Copy): PhysicalBodyHead =>
    Object.freeze({
      ...copy.identity,
      generation: copy.identity.generation + (copy.state === "fenced" ? 1 : 0),
      format: OWNER_PHYSICAL_BODY_FORMAT,
      state: copy.state,
      byteLength: copy.byteLength,
      versionToken: copy.versionToken,
    });
  const fresh = (
    identity: PhysicalWriterIdentity,
    state: Copy["state"],
  ): Copy => ({
    identity,
    state,
    byteLength: 0,
    versionToken: version(),
    chunks: [],
    appends: new Map(),
  });
  return Object.freeze(
    {
      reserve(input) {
        const identity = capturePhysicalIdentity(input);
        let copy = copies.get(identity.bodyId);
        if (copy) {
          if (
            copy.state !== "open" ||
            !samePhysicalWriter(copy.identity, identity)
          ) conflict();
        } else {
          copy = fresh(identity, "open");
          copies.set(identity.bodyId, copy);
        }
        return Promise.resolve(head(copy));
      },
      append(input) {
        const request = capturePhysicalAppend(input);
        const copy = copies.get(request.writer.bodyId);
        if (
          !copy || copy.state !== "open" ||
          !samePhysicalWriter(copy.identity, request.writer)
        ) conflict();
        const previous = copy.appends.get(request.appendId);
        if (previous) {
          if (
            previous.offset !== request.expectedOffset ||
            previous.bytes.byteLength !== request.bytes.byteLength ||
            !previous.bytes.every((byte, index) =>
              byte === request.bytes[index]
            )
          ) conflict();
        } else {
          if (request.expectedOffset !== copy.byteLength) conflict();
          copy.chunks.push(request.bytes);
          copy.appends.set(request.appendId, {
            offset: request.expectedOffset,
            bytes: request.bytes,
          });
          copy.byteLength += request.bytes.byteLength;
          copy.versionToken = version();
        }
        return Promise.resolve(Object.freeze({
          startOffset: request.expectedOffset,
          endOffset: copy.byteLength,
          versionToken: copy.versionToken,
        }));
      },
      fence(input) {
        const identity = capturePhysicalIdentity(input);
        let copy = copies.get(identity.bodyId);
        if (!copy) {
          copy = fresh(identity, "fenced");
          copies.set(identity.bodyId, copy);
        } else {
          if (!samePhysicalWriter(copy.identity, identity)) conflict();
          if (copy.state === "open") {
            copy.state = "fenced";
            copy.versionToken = version();
          }
        }
        return Promise.resolve(head(copy));
      },
      head(input) {
        const copy = copies.get(physicalIdentifier(input));
        return Promise.resolve(copy ? head(copy) : null);
      },
      readRange(input) {
        const request = capturePhysicalRange(input);
        const copy = copies.get(request.bodyId);
        if (!copy) {
          throw createContentError(
            "asset_not_found",
            "Physical copy does not exist.",
          );
        }
        if (
          request.end > copy.byteLength ||
          copy.chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !==
            copy.byteLength
        ) {
          throw createContentError(
            "asset_storage_unavailable",
            "Requested physical bytes are missing.",
          );
        }
        return Promise.resolve(
          sliceBodyChunks(copy.chunks, request.offset, request.end),
        );
      },
    } satisfies PhysicalBodyStore,
  );
}
