import { assert, assertEquals } from "@std/assert";

import * as nodeAdapter from "./index.ts";
import { createInteractiveCliIo, startInteractiveCli } from "./index.ts";

Deno.test("Node CLI adapter explicitly owns readline terminal access", async () => {
  assertEquals(typeof createInteractiveCliIo, "function");
  assertEquals(typeof startInteractiveCli, "function");
  assertEquals("createNodeInteractiveCliIo" in nodeAdapter, false);
  assertEquals("startNodeInteractiveCli" in nodeAdapter, false);
  const source = await Deno.readTextFile(new URL("cli.ts", import.meta.url));
  assert(/from\s+["']node:readline\/promises["']/.test(source));
  assert(/from\s+["']node:process["']/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  const generic = await Deno.readTextFile(
    new URL("../index.ts", import.meta.url),
  );
  assert(!/adapters\/node|\.\/node\//.test(generic));
});
