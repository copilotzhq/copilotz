import { assertEquals } from "@std/assert";

Deno.test("channel runtime bootstraps identities from collections, not conversation", async () => {
  const source = await Deno.readTextFile(
    new URL("./runtime.ts", import.meta.url),
  );
  assertEquals(source.includes("application.conversation"), false);
  const identity = await Deno.readTextFile(
    new URL("./identity.ts", import.meta.url),
  );
  assertEquals(identity.includes("application.conversation"), false);
  assertEquals(identity.includes("collectionRuntime"), true);
  const helpers = await Deno.readTextFile(
    new URL("./helpers.ts", import.meta.url),
  );
  assertEquals(helpers.includes("application.conversation"), false);
  const whatsapp = await Deno.readTextFile(
    new URL("./whatsapp/channel.ts", import.meta.url),
  );
  assertEquals(whatsapp.includes("application.conversation"), false);
});
