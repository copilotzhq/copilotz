import { assertEquals } from "@std/assert";
import { createSaveAssetAction } from "../../actions/save-asset/index.ts";
import { createSaveAssetToolResource } from "./index.ts";
Deno.test("save-asset Resource exposes its alias", () =>
  assertEquals(
    createSaveAssetToolResource(createSaveAssetAction()).action,
    "save_asset",
  ));
