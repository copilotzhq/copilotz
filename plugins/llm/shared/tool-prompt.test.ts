import { assertEquals } from "@std/assert";
import { generateToolSystemPromptVariant } from "./tool-prompt.ts";

Deno.test("tool prompts describe parallel JSON-line branches and sequential pipelines", () => {
  const tools = [{
    type: "function" as const,
    function: {
      name: "lookup",
      description: "Look up one record.",
      inputTypes: "{ id: string }",
    },
  }];

  for (const variant of ["baseline", "strict-minimal"] as const) {
    const prompt = generateToolSystemPromptVariant(tools, variant);
    assertEquals(
      prompt.toLowerCase().includes("new lines run in parallel"),
      true,
    );
    assertEquals(prompt.includes(" | "), true);
    assertEquals(prompt.includes("jq"), true);
    assertEquals(prompt.includes("batch_id"), false);
  }
});
