import { defineCollection } from "@copilotz/copilotz/authoring";
export default defineCollection({
  name: "demo_plan",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      runId: { type: "string" },
      title: { type: "string", maxLength: 160 },
      status: { type: "string", enum: ["draft", "reviewed", "published"] },
      steps: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        maxItems: 8,
      },
      review: { type: "string", maxLength: 500 },
      clock: { type: "string" },
      reviewedAt: { type: "string" },
      execution: { type: "string", const: "browser-worker" },
    },
    required: [
      "runId",
      "title",
      "status",
      "steps",
      "review",
      "clock",
      "execution",
    ],
  } as const,
});
