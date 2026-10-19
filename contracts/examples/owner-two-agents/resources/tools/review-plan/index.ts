import { defineTool } from "@copilotz/copilotz/core";
import action from "../../../actions/review-plan/index.ts";
export default defineTool("reviewPlan", action, {
  name: "reviewPlan",
  description:
    "Review the saved draft and add missing rollback and verification steps.",
});
