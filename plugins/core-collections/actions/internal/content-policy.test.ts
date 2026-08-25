import { assertEquals, assertInstanceOf } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ContentInput, PreparedContent } from "@copilotz/copilotz/content";
import { prepareActionContent } from "./content-policy.ts";

Deno.test("Action content preparation decodes JSON-safe media at the Action boundary", async () => {
  let received: ContentInput | readonly ContentInput[] | undefined;
  let operationKey: string | undefined;
  const expected: PreparedContent = Object.freeze({
    content: Object.freeze([]),
    assets: Object.freeze([]),
  });
  const context = {
    content: {
      prepare(
        input: ContentInput | readonly ContentInput[],
        options?: Readonly<{ operationKey?: string }>,
      ) {
        received = input;
        operationKey = options?.operationKey;
        return Promise.resolve(expected);
      },
    },
  } as unknown as Pick<ActionContext, "content">;

  const result = await prepareActionContent(
    [
      { type: "text", text: "hello" },
      {
        type: "file",
        dataBase64: "AQID",
        mediaType: "application/octet-stream",
        name: "payload.bin",
      },
    ],
    context,
    "message-content",
  );

  assertEquals(result, expected);
  assertEquals(operationKey, "message-content");
  const parts = received as readonly Record<string, unknown>[];
  assertEquals(parts[0], { type: "text", text: "hello" });
  assertEquals(parts[1].type, "file");
  assertEquals(parts[1].mediaType, "application/octet-stream");
  assertEquals(parts[1].name, "payload.bin");
  assertEquals("dataBase64" in parts[1], false);
  assertInstanceOf(parts[1].bytes, Uint8Array);
  assertEquals([...parts[1].bytes as Uint8Array], [1, 2, 3]);
});
