import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { fetchAssetToolResource } from "./index.ts";
Deno.test("fetch-asset Resource exposes its alias", () =>
  assertEquals(
    fetchAssetToolResource[contribution]({
      namespace: "tools",
      alias: "fetch_asset",
    }).value.action,
    "fetch_asset",
  ));
