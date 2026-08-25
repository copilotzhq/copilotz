import { assertEquals } from "@std/assert";
import { createSkillActionResources } from "./index.ts";

Deno.test("Skill generator can omit every optional Tool", () => {
  const contribution = createSkillActionResources({ include: [] });
  assertEquals(Object.keys(contribution.actions), []);
  assertEquals(Object.keys(contribution.tools), []);
});
