import { assertEquals } from "@std/assert";
import { createPersistentTerminalAction } from "./index.ts";

Deno.test("Persistent Terminal Action uses the configured alias", () => {
  const action = createPersistentTerminalAction({
    terminal: {
      execute: async () => ({}),
      shutdown: async () => {},
    },
  }, "terminal_test");
  assertEquals(
    action.id,
    "copilotz.tools.persistent-terminal.terminal_test",
  );
});
