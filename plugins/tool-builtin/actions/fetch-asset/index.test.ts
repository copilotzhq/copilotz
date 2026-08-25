import { assertEquals } from "@std/assert";
import { createFetchAssetAction } from "./index.ts";
Deno.test("fetch-asset Action owns its id", () =>
  assertEquals(
    createFetchAssetAction().id,
    "copilotz.tools.builtin.fetch_asset",
  ));
