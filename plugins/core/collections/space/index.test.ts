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
