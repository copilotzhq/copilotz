import { assertEquals, assertInstanceOf } from "@std/assert";
import { decodeContent } from "@copilotz/copilotz/content";

Deno.test("Action content preparation decodes JSON-safe media at the Action boundary", () => {
  const result = decodeContent(
    [
      { type: "text", text: "hello" },
      {
        type: "file",
        dataBase64: "AQID",
        mediaType: "application/octet-stream",
        name: "payload.bin",
      },
    ],
  );

  const parts = result as readonly Record<string, unknown>[];
  assertEquals(parts[0], { type: "text", text: "hello" });
  assertEquals(parts[1].type, "file");
  assertEquals(parts[1].mediaType, "application/octet-stream");
  assertEquals(parts[1].name, "payload.bin");
  assertEquals("dataBase64" in parts[1], false);
  assertInstanceOf(parts[1].bytes, Uint8Array);
  assertEquals([...parts[1].bytes as Uint8Array], [1, 2, 3]);
});
