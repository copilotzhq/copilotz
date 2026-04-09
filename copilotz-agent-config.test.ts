import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCopilotz } from "./index.ts";
import adminConfig from "./agents/admin/config.ts";

Deno.test("copilotzAgent accepts normal agent overrides including instructions and allowedTools", async () => {
  const copilotz = await createCopilotz({
    copilotzAgent: {
      name: "dev-assistant",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      instructions: "Use only the persistent terminal tool.",
      allowedTools: ["persistent_terminal"],
    },
    dbConfig: { url: ":memory:" },
    agentsFile: false,
  });

  try {
    const agents = copilotz.config.agents ?? [];
    const agent = agents.find((candidate) =>
      (candidate.id ?? candidate.name) === "dev-assistant"
    );

    assertExists(agent);
    assertEquals(agent.id, "dev-assistant");
    assertEquals(agent.name, "dev-assistant");
    assertEquals(agent.instructions, "Use only the persistent terminal tool.");
    assertEquals(agent.allowedTools, ["persistent_terminal"]);
    assertEquals(agent.description, adminConfig.description);
  } finally {
    await copilotz.shutdown();
  }
});
