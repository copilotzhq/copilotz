import { assertEquals, assertThrows } from "@std/assert";
import {
  BODY_MANIFEST_DECODE_BYTES,
  bodyObjectLimits,
  checkBodyObjectGrowth,
  decodeBodyObjectManifest,
  encodeBodyObjectManifest,
} from "./body-object-manifest.ts";
import type { StoredBody } from "./body-store-operations.ts";
const digest = `sha256:${"0".repeat(64)}` as const;
const body: StoredBody = {
  bodyId: "body",
  mediaType: "text/plain",
  reservationId: "reservation",
  generation: 7,
  fencedFrom: null,
  state: "open",
  byteLength: 3,
  digest: null,
  revision: 1,
  nonce: "version",
  updatedAt: "2026-10-18T00:00:00.000Z",
  parts: [{ appendId: "one", offset: 0, length: 3, digest }],
};
const decode = (value: unknown) =>
  decodeBodyObjectManifest(
    new TextEncoder().encode(JSON.stringify(value)),
    "body",
  );
Deno.test("body object manifest retains exact identity, original fenced generation and opaque keys", () => {
  assertEquals(decode(body), body);
  assertEquals(decode({ ...body, generation: 8, fencedFrom: 7 }).generation, 8);
  for (
    const value of [
      { ...body, bodyId: "other" },
      { ...body, extra: 1 },
      { ...body, generation: 8, fencedFrom: 6 },
      { ...body, reservationId: " leading" },
      { ...body, generation: 0 },
    ]
  ) assertThrows(() => decode(value));
});
Deno.test("body object manifest validates contiguous coverage, unique IDs and bounded parts", () => {
  for (
    const value of [
      { ...body, byteLength: 4 },
      { ...body, parts: [{ ...body.parts[0], offset: 1 }] },
      { ...body, parts: [{ ...body.parts[0], length: 0 }] },
      {
        ...body,
        byteLength: 1048577,
        parts: [{ ...body.parts[0], length: 1048577 }],
      },
      {
        ...body,
        byteLength: 6,
        parts: [body.parts[0], { ...body.parts[0], offset: 3 }],
      },
      { ...body, parts: [{ ...body.parts[0], digest: "bad" }] },
      { ...body, state: "ready", digest: null },
    ]
  ) assertThrows(() => decode(value));
  assertEquals(
    decode({ ...body, state: "incomplete", byteLength: 2, digest }).byteLength,
    2,
  );
  assertEquals(
    decode({
      ...body,
      state: "ready",
      generation: 8,
      fencedFrom: 7,
      byteLength: 2,
      digest,
    }).byteLength,
    2,
  );
  assertThrows(() =>
    decode({ ...body, state: "ready", byteLength: 2, digest })
  );
});
Deno.test("body object growth counts escaped UTF-8 bytes before upload without limiting retained decode", () => {
  const escaped = {
    ...body,
    bodyId: 'body/é/"\\',
    parts: [{ ...body.parts[0], appendId: "世界" }],
  };
  const size = encodeBodyObjectManifest(escaped).length;
  assertEquals(
    checkBodyObjectGrowth(escaped, bodyObjectLimits({ maxManifestBytes: size }))
      .length,
    size,
  );
  assertThrows(() =>
    checkBodyObjectGrowth(
      escaped,
      bodyObjectLimits({ maxManifestBytes: size - 1 }),
    )
  );
  assertEquals(
    decodeBodyObjectManifest(encodeBodyObjectManifest(escaped)).bodyId,
    escaped.bodyId,
  );
  assertThrows(() =>
    decodeBodyObjectManifest(new Uint8Array(BODY_MANIFEST_DECODE_BYTES + 1))
  );
  assertThrows(() => bodyObjectLimits({ maxParts: 8193 }));
});
