import { type ActionContext, defineAction } from "@copilotz/copilotz/authoring";
import { assertBrowserWorker } from "../../shared/browser.ts";
import { runInput } from "../../shared/plan.ts";
export default defineAction({
  id: "demo.plan.saveDraft",
  inputSchema: {
    ...runInput,
    properties: {
      ...runInput.properties,
      clock: { type: "string", minLength: 10, maxLength: 80 },
    },
    required: ["runId", "clock"],
  },
  async execute(
    input: { runId: string; clock: string },
    context: ActionContext,
  ) {
    assertBrowserWorker();
    const { runId, clock } = input;
    return await context.collections.plan.create({
      id: runId,
      runId: runId,
      title: "Ship a small release safely",
      status: "draft",
      steps: ["Run the tests", "Deploy the release"],
      review: "Awaiting the reviewer",
      clock,
      execution: "browser-worker",
    }, { operationKey: `draft:${runId}` });
  },
});
