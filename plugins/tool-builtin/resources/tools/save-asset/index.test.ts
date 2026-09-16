import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { saveAssetToolResource } from "./index.ts";
Deno.test("save-asset Resource exposes its alias", () =>
  assertEquals(
    saveAssetToolResource[contribution]({
      namespace: "tools",
      alias: "save_asset",
    }).value.action,
    "save_asset",
  ));
