/** A real Core Agent resource. Only the model implementation is scripted. */
export default {
  id: "reviewer",
  name: "reviewer",
  role: "The reviewer in a deterministic release-plan acceptance scenario.",
  instructions:
    "Use your granted tools. Treat tool failures as failures. The coordinator must ask the reviewer before publishing.",
  models: { generate: [{ connection: "demo", model: "reviewer-script" }] },
  capabilities: {
    tools: ["get_current_time", "readPlan", "reviewPlan"],
    agents: [],
    skills: [],
  },
} as const;
