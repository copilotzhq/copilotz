import { assertEquals } from "@std/assert";
import { defineInlineSkill } from "./index.ts";

Deno.test("defineInlineSkill creates an immutable Skill Resource", () => {
  const skill = defineInlineSkill({
    markdown:
      "---\nname: layout-test\ndescription: Validates the Skill Resource layout.\n---\n# Test",
  });
  assertEquals(skill.name, "layout-test");
  assertEquals(Object.isFrozen(skill), true);
});
