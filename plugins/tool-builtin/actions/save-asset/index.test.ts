import { assertEquals } from "@std/assert";
import { createSaveAssetAction } from "./index.ts";
Deno.test("save-asset Action owns its id", () =>
  assertEquals(
    createSaveAssetAction().id,
    "copilotz.tools.builtin.save_asset",
  ));
