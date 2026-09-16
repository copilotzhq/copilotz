import { assertEquals } from "@std/assert";
import { persistentTerminalAction } from "./index.ts";

Deno.test("Persistent Terminal Action has stable native identity", () => {
  const action = persistentTerminalAction;
  assertEquals(
    action.id,
    "copilotz.tools.persistent-terminal.persistent_terminal",
  );
});
