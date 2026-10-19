/** A real Core Agent resource. Only the model implementation is scripted. */
export default {
  id: "coordinator",
  name: "coordinator",
  role: "The coordinator in a deterministic release-plan acceptance scenario.",
  instructions:
    "Use your granted tools. Treat tool failures as failures. The coordinator must ask the reviewer before publishing.",
  models: { generate: [{ connection: "demo", model: "coordinator-script" }] },
  capabilities: {
    tools: ["get_current_time", "saveDraft", "publishPlan"],
    agents: ["reviewer"],
    skills: [],
  },
} as const;
