import { assertEquals } from "@std/assert";

Deno.test("slice 4 reconnect cursors use event position and stream offsets", async () => {
  const types = await Deno.readTextFile(
    new URL("./types.ts", import.meta.url),
  );
  assertEquals(types.includes("afterPosition?: string"), true);
  assertEquals(types.includes("streamOffsets?:"), true);

  const attachment = await Deno.readTextFile(
    new URL("./attachment.ts", import.meta.url),
  );
  assertEquals(attachment.includes("listEvents"), true);
  assertEquals(attachment.includes("offset"), true);

  const runtime = await Deno.readTextFile(
    new URL("../channels/runtime.ts", import.meta.url),
  );
  assertEquals(runtime.includes("last-event-id"), true);
  assertEquals(runtime.includes("streamOffsets"), true);

  const fetch = await Deno.readTextFile(
    new URL("../../server/fetch.ts", import.meta.url),
  );
  assertEquals(fetch.includes("id: ${resumeId}"), true);
  assertEquals(fetch.includes("durablePosition"), true);
});
