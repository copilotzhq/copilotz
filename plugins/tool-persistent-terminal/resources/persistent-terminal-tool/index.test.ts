import { assertEquals } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { createPersistentTerminalToolResource } from "./index.ts";

Deno.test("Persistent Terminal Tool Resource maps its alias", () => {
  const resource = createPersistentTerminalToolResource(
    "terminal_test",
    defineAction({ id: "fixture.terminal", execute: () => null }),
  );
  assertEquals(resource.action, "terminal_test");
});
