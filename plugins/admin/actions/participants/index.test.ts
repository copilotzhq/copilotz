import { assertEquals } from "@std/assert";
import { adminParticipantsAction } from "./index.ts";

Deno.test("admin participants Action declares its canonical identity and schema", () => {
  assertEquals(adminParticipantsAction.id, "copilotz.admin.participants");
  assertEquals(
    adminParticipantsAction.inputSchema?.required,
    ["resource", "method"],
  );
});
