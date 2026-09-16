import { assertEquals } from "@std/assert";
import { saveAssetAction } from "./index.ts";
Deno.test("save-asset Action owns its id", () =>
  assertEquals(
    saveAssetAction.id,
    "copilotz.tools.builtin.save_asset",
  ));
