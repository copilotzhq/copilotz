import { assertEquals } from "@std/assert";
import { coreHttpPlugin } from "./index.ts";
import updateConversation from "./actions/update-conversation/index.ts";
Deno.test("Core HTTP owns four mutations and one optional transport", () => {
  assertEquals(Object.keys(coreHttpPlugin.actions).length, 4);
  assertEquals(Object.keys(coreHttpPlugin.adapters.http), ["core"]);
});

Deno.test("conversation updates preserve ordinary fields and reject unknown fields", () => {
  const patch = updateConversation.inputSchema!.properties?.patch as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  assertEquals(patch.additionalProperties, false);
  assertEquals(patch.properties?.name, { type: "string" });
  assertEquals(patch.properties?.description, { type: "string" });
  assertEquals(patch.properties?.status, {
    enum: ["active", "archived", "closed"],
  });
});
