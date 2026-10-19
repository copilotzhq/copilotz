/** Pure primitive composition shared by owner and browser Worker. */
import { definePlugin } from "@copilotz/copilotz/authoring";
import { corePlugin } from "@copilotz/copilotz/core";
import { serverPlugin } from "@copilotz/copilotz/server";
import plan from "./collections/plan/index.ts";
import evidence from "./collections/evidence/index.ts";
import saveDraft from "./actions/save-draft/index.ts";
import readPlan from "./actions/read-plan/index.ts";
import reviewPlan from "./actions/review-plan/index.ts";
import publishPlan from "./actions/publish-plan/index.ts";
import recordEvidence from "./processors/record-evidence/index.ts";
import coordinator from "./resources/agents/coordinator/index.ts";
import reviewer from "./resources/agents/reviewer/index.ts";
import saveDraftTool from "./resources/tools/save-draft/index.ts";
import readPlanTool from "./resources/tools/read-plan/index.ts";
import reviewPlanTool from "./resources/tools/review-plan/index.ts";
import publishPlanTool from "./resources/tools/publish-plan/index.ts";
import getCurrentTime from "./resources/tools/get-current-time/index.ts";
import demo from "./resources/llmConnections/demo/index.ts";
import scripted from "./adapters/llm/scripted/index.ts";
export const demoPlugin = definePlugin({
  id: "@examples/owner-two-agents",
  version: "1.0.0",
  plugins: [corePlugin, serverPlugin],
  collections: { plan, evidence },
  actions: { saveDraft, readPlan, reviewPlan, publishPlan },
  processors: { recordEvidence },
  resources: {
    agents: { coordinator, reviewer },
    llmConnections: { demo },
    tools: {
      saveDraft: saveDraftTool,
      readPlan: readPlanTool,
      reviewPlan: reviewPlanTool,
      publishPlan: publishPlanTool,
      get_current_time: getCurrentTime,
    },
  },
  adapters: { llm: { scripted } },
});
