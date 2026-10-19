import { defineTool } from "@copilotz/copilotz/core";
import action from "../../../actions/publish-plan/index.ts";
export default defineTool("publishPlan", action, {
  name: "publishPlan",
  description:
    "Publish the saved plan only after the specialist has reviewed it.",
});
