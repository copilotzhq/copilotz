import { assertEquals } from "@std/assert";

import {
  base64ToBytes,
  bytesToBase64,
  parseDataUrl,
  toDataUrl,
} from "./encoding.ts";

Deno.test("canonical base64 encoding round-trips binary content", () => {
  const bytes = new Uint8Array(100_000);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 256;
  }

  assertEquals(base64ToBytes(bytesToBase64(bytes)), bytes);
});

Deno.test("canonical data URLs preserve media type and bytes", () => {
  const bytes = new TextEncoder().encode("Copilotz: áudio + text");
  const parsed = parseDataUrl(toDataUrl(bytes, "text/plain;charset=utf-8"));

  assertEquals(parsed?.mediaType, "text/plain");
  assertEquals(parsed?.bytes, bytes);
});

Deno.test("canonical data URL parser supports percent encoding and rejects malformed input", () => {
  const parsed = parseDataUrl("data:text/plain,hello%20world");

  assertEquals(parsed?.mediaType, "text/plain");
  assertEquals(new TextDecoder().decode(parsed?.bytes), "hello world");
  assertEquals(parseDataUrl("https://example.com/file"), null);
  assertEquals(parseDataUrl("data:text/plain;base64,%%%"), null);
});
