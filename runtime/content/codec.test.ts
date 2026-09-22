import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeContent, encodeContent } from "./codec.ts";
import type { ContentInput } from "./types.ts";

Deno.test("media codec round-trips all byte values, metadata and mixed content through JSON", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const input: readonly ContentInput[] = [
    "hello 🌎",
    { type: "json", value: { nested: [true, null, "你好"] } },
    ...(["file", "image", "audio", "video"] as const).map((type) => ({
      type,
      bytes,
      mediaType: "application/octet-stream",
      name: "payload",
      disposition: "attachment" as const,
      metadata: { source: "test" },
    })),
    { assetId: "asset", kind: "text", role: "body", mediaType: "text/plain" },
  ];
  const wire = encodeContent(input);
  const decoded = decodeContent(JSON.parse(JSON.stringify(wire)));
  assertEquals(decoded, input);
  bytes[0] = 99;
  assert(Array.isArray(decoded));
  assertEquals(decoded[2].bytes[0], 0);
  assertEquals(
    decodeContent(
      encodeContent({
        type: "file",
        bytes: new Uint8Array(),
        mediaType: "application/octet-stream",
      }),
    ),
    {
      type: "file",
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
    },
  );
});

Deno.test("media codec normalizes explicit data URLs without fetching", () => {
  assertEquals(
    decodeContent({
      type: "file",
      dataUrl: "data:application/octet-stream;base64,AP8=",
    }),
    {
      type: "file",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([0, 255]),
    },
  );
  assertEquals(
    decodeContent({ type: "file", dataUrl: "data:text/plain,hello%20world" }),
    {
      type: "file",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello world"),
    },
  );
});

Deno.test("media codec rejects malformed, ambiguous and non-JSON content", () => {
  for (
    const input of [
      { type: "file", dataBase64: "!" },
      { type: "file", dataBase64: "AB==" },
      { type: "file", dataBase64: "AA" },
      { type: "file", dataBase64: "AA==", bytes: new Uint8Array() },
      { type: "file", dataUrl: "https://example.com/image" },
      { type: "file", url: "data:text/plain,a" },
      { type: "file", dataUrl: "data:text/plain,a", mediaType: "image/png" },
      { type: "file", bytes: [1, 2], mediaType: "application/octet-stream" },
      { type: "file", dataBase64: "", mediaType: "" },
      { type: "json", value: NaN },
      { type: "json", value: undefined },
      { type: "json", value: new Date() },
      { content: [], assets: [] },
    ]
  ) assertThrows(() => decodeContent(input));
});

Deno.test("media codec rejects getters before taking its input snapshot", () => {
  let reads = 0;
  const content = {
    type: "text",
    get text() {
      reads++;
      return "hidden evaluation";
    },
  };
  assertThrows(() => decodeContent(content), TypeError);
  assertEquals(reads, 0);
});

Deno.test("content codec re-ingresses hydrated references as canonical refs", () => {
  assertEquals(
    decodeContent({
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      value: "hydrated body",
      resolve: true,
      extra: "not durable",
      metadata: {
        nested: {
          assetId: "asset-b",
          kind: "json",
          role: "attachment",
          mediaType: "application/json",
          value: { hydrated: true },
        },
      },
    }),
    {
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      metadata: {
        nested: {
          assetId: "asset-b",
          kind: "json",
          role: "attachment",
          mediaType: "application/json",
        },
      },
    },
  );
});
