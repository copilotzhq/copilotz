/** The list of every front end's word keys (WORDS.md) is the one the code defines. */
import { readFileSync } from "node:fs";
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { keysDoc } from "./keys.ts";

test("hosts/web/WORDS.md lists the keys as defined (deno run -A hosts/web/tests/keys.ts)", () => {
  const written = readFileSync(new URL("../WORDS.md", import.meta.url), "utf8");
  assertEquals(written, keysDoc());
});
