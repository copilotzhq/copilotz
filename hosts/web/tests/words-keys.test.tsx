/** The list of every front end's word keys (WORDS.md) is the one the code defines. */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { keysDoc } from "./keys.ts";

test("hosts/web/WORDS.md lists the keys as defined (deno run -A hosts/web/tests/keys.ts)", async () => {
  const written = await Deno.readTextFile(new URL("../WORDS.md", import.meta.url));
  assertEquals(written, keysDoc());
});
