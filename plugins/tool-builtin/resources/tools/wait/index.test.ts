import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { waitToolResource } from "./index.ts";
Deno.test("wait Resource exposes its alias", () =>
  assertEquals(
    waitToolResource[contribution]({ namespace: "tools", alias: "wait" }).value
      .action,
    "wait",
  ));
