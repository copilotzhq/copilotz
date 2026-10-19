import { defineCollection } from "@copilotz/copilotz/authoring";
export default defineCollection({
  name: "demo_evidence",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      fact: { type: "string" },
      sourceId: { type: "string" },
      agent: { type: "string" },
      runId: { type: "string" },
      correlationId: { type: "string" },
      causationId: { type: "string" },
      execution: { type: "string", const: "browser-worker" },
      at: { type: "string" },
    },
    required: ["fact", "sourceId", "agent", "runId", "execution", "at"],
  } as const,
});
