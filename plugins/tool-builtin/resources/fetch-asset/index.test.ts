import { assertEquals } from "@std/assert";
import { createFetchAssetAction } from "../../actions/fetch-asset/index.ts";
import { createFetchAssetToolResource } from "./index.ts";
Deno.test("fetch-asset Resource exposes its alias", () =>
  assertEquals(
    createFetchAssetToolResource(createFetchAssetAction()).action,
    "fetch_asset",
  ));
