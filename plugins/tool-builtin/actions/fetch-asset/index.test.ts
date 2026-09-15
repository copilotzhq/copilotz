import { assertEquals } from "@std/assert";
import { fetchAssetAction } from "./index.ts";
Deno.test("fetch-asset Action owns its id", () =>
  assertEquals(
    fetchAssetAction.id,
    "copilotz.tools.builtin.fetch_asset",
  ));
