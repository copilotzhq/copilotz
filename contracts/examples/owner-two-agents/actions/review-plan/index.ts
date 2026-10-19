import { type ActionContext, defineAction } from "@copilotz/copilotz/authoring";
import { assertBrowserWorker } from "../../shared/browser.ts";
import { runInput } from "../../shared/plan.ts";
export default defineAction({
  id: "demo.plan.review",
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
    // Return the exact owner-recorded mutation result, including on replay.
    // A current-row read cannot prove this invocation performed the transition.
    return await context.collections.plan.update({
      id: runId,
      set: {
        status: "reviewed",
        reviewedAt: clock,
        review: "Add a rollback checkpoint and verify the deployed build.",
        steps: [
          "Run the tests",
          "Record a rollback checkpoint",
          "Deploy the release",
          "Verify the deployed build",
        ],
      },
    }, {
      operationKey: `review:${runId}`,
      condition: { current: { where: { runId, status: "draft" } } },
    });
  },
});
