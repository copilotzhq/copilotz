import { type ActionContext, defineAction } from "@copilotz/copilotz/authoring";
import { assertBrowserWorker } from "../../shared/browser.ts";
import { runInput } from "../../shared/plan.ts";
export default defineAction({
  id: "demo.plan.publish",
  inputSchema: runInput,
  async execute(input: { runId: string }, context: ActionContext) {
    assertBrowserWorker();
    const { runId } = input;
    // Return the exact owner-recorded mutation result, including on replay.
    // A current-row read cannot prove this invocation performed the transition.
    return await context.collections.plan.update({
      id: runId,
      set: {
        status: "published",
        review:
          "Reviewed: rollback checkpoint and post-deploy verification included.",
        steps: [
          "Run the tests",
          "Record a rollback checkpoint",
          "Deploy the release",
          "Verify the deployed build",
        ],
      },
    }, {
      operationKey: `publish:${runId}`,
      condition: { current: { where: { runId, status: "reviewed" } } },
    });
  },
});
