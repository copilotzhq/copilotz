import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { persistentTerminalToolResource } from "./index.ts";

Deno.test("Persistent Terminal Tool Resource maps its alias", () => {
  const resource = persistentTerminalToolResource;
  assertEquals(
    resource[contribution]({ namespace: "tools", alias: "terminal_test" }).value
      .action,
    "terminal_test",
  );
});
