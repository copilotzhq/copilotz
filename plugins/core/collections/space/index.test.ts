import { assertEquals, assertRejects } from "@std/assert";
import { spaceCollection } from "./index.ts";

Deno.test("Space membership cannot remove the owner and additions are idempotent", async () => {
  const current = { ownerId: "owner", memberIds: ["owner", "member"] };
  const mutate = spaceCollection.commands!.member.mutate;
  assertEquals(mutate({ current, input: { participantId: "member" } }), {
    set: { memberIds: ["owner", "member"] },
  });
  await assertRejects(async () => {
    mutate({ current, input: { participantId: "owner", remove: true } });
  });
});

Deno.test("Space metadata description is optional for existing records", () => {
  const schema = spaceCollection.schema as {
    properties: Record<string, unknown>;
    required: readonly string[];
  };
  assertEquals(schema.properties.description, {
    type: "string",
  });
  assertEquals(schema.required.includes("description"), false);
});
