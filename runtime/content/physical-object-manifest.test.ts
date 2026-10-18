import { assertEquals, assertThrows } from "@std/assert";
import {
  checkPhysicalObjectGrowth,
  decodePhysicalObjectManifest,
  encodePhysicalObjectManifest,
  PHYSICAL_MANIFEST_DECODE_BYTES,
  PHYSICAL_MANIFEST_DECODE_PARTS,
  physicalObjectGrowthLimits,
  type PhysicalObjectManifest,
} from "./physical-object-manifest.ts";

const fresh = (): PhysicalObjectManifest => ({
  format: "owner-physical-v1",
  scope: "owner/one",
  identity: {
    bodyId: "copy/one",
    mediaType: "text/plain",
    reservationId: "reservation",
    generation: 7,
  },
  state: "open",
  byteLength: 0,
  parts: [],
});
const decode = (value: unknown) =>
  decodePhysicalObjectManifest(
    new TextEncoder().encode(JSON.stringify(value)),
    "owner/one",
    "copy/one",
  );
const part = {
  appendId: "append",
  offset: 0,
  length: 2,
  digest: `sha256:${"a".repeat(64)}`,
};
Deno.test("physical object manifest is exact, retains original generation and rejects identity aliases", () => {
  for (const state of ["open", "fenced"] as const) {
    const input = { ...fresh(), state, byteLength: 2, parts: [part] };
    assertEquals(decode(input), input);
    const output = decode(input);
    assertThrows(() => Object.assign(output.identity, { generation: 8 }));
    assertThrows(() => Object.assign(output.parts[0], { offset: 1 }));
  }
  for (
    const value of [
      { ...fresh(), extra: true },
      { ...fresh(), scope: "owner/two" },
      { ...fresh(), identity: { ...fresh().identity, bodyId: "copy/two" } },
      {
        ...fresh(),
        identity: { ...fresh().identity, generation: Number.MAX_SAFE_INTEGER },
      },
      { ...fresh(), format: "legacy" },
      { ...fresh(), state: "ready" },
    ]
  ) assertThrows(() => decode(value));
});
Deno.test("physical object manifest validates contiguous coverage, duplicate IDs and bounded parts", () => {
  for (
    const value of [
      { ...fresh(), byteLength: 1 },
      { ...fresh(), byteLength: 2, parts: [{ ...part, offset: 1 }] },
      { ...fresh(), byteLength: 2, parts: [{ ...part, length: 0 }] },
      { ...fresh(), byteLength: 2, parts: [{ ...part, digest: "anything" }] },
      { ...fresh(), byteLength: 2, parts: [{ ...part, key: "legacy/unsafe" }] },
      { ...fresh(), byteLength: 4, parts: [part, { ...part, offset: 2 }] },
      {
        ...fresh(),
        byteLength: 1048577,
        parts: [{ ...part, length: 1048577 }],
      },
      {
        ...fresh(),
        parts: Array(PHYSICAL_MANIFEST_DECODE_PARTS + 1).fill(part),
      },
    ]
  ) assertThrows(() => decode(value));
  assertThrows(() =>
    decodePhysicalObjectManifest(
      new Uint8Array(PHYSICAL_MANIFEST_DECODE_BYTES + 1),
      "owner/one",
      "copy/one",
    )
  );
  assertThrows(() =>
    decodePhysicalObjectManifest(new Uint8Array([255]), "owner/one", "copy/one")
  );
});
Deno.test("physical object growth checks exact UTF-8 serialized bytes before admission", () => {
  const input = {
    ...fresh(),
    identity: { ...fresh().identity, reservationId: 'r\\"\n日本語' },
  };
  const encoded = encodePhysicalObjectManifest(input);
  const limits = physicalObjectGrowthLimits({
    maxManifestBytes: encoded.byteLength,
    maxParts: 1,
  });
  assertEquals(checkPhysicalObjectGrowth(input, limits), encoded);
  assertThrows(() =>
    checkPhysicalObjectGrowth(input, {
      ...limits,
      maxManifestBytes: encoded.byteLength - 1,
    })
  );
  assertEquals(
    decodePhysicalObjectManifest(encoded, input.scope, input.identity.bodyId),
    input,
  );
  assertEquals(
    encodePhysicalObjectManifest({ ...input, state: "fenced" }).byteLength,
    encoded.byteLength + 2,
  );
});
Deno.test("physical object growth caps do not enter retained decoding or fencing", () => {
  const retained = {
    ...fresh(),
    byteLength: 4,
    parts: [part, { ...part, appendId: "next", offset: 2 }],
  };
  const lower = physicalObjectGrowthLimits({
    maxParts: 1,
    maxManifestBytes: 1,
  });
  assertThrows(() => checkPhysicalObjectGrowth(retained, lower));
  assertEquals(decode(retained), retained);
  assertEquals(decode({ ...retained, state: "fenced" }), {
    ...retained,
    state: "fenced",
  });
  assertEquals(
    checkPhysicalObjectGrowth(
      retained,
      physicalObjectGrowthLimits({ maxParts: 2 }),
    ).length > 0,
    true,
  );
  for (
    const input of [
      { maxParts: 0 },
      { maxParts: PHYSICAL_MANIFEST_DECODE_PARTS + 1 },
      { maxParts: 1.5 },
      { maxManifestBytes: PHYSICAL_MANIFEST_DECODE_BYTES - 1 },
      { maxManifestBytes: NaN },
    ]
  ) assertThrows(() => physicalObjectGrowthLimits(input));
});
