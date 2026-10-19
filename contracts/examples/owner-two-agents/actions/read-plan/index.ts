import { type ActionContext, defineAction } from "@copilotz/copilotz/authoring";
import { assertBrowserWorker } from "../../shared/browser.ts";
import { requirePlan, runInput } from "../../shared/plan.ts";
export default defineAction({
  id: "demo.plan.read",
  inputSchema: runInput,
  async execute(input: { runId: string }, context: ActionContext) {
    assertBrowserWorker();
    return await requirePlan(context, input.runId);
  },
});
