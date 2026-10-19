import { defineTool } from "@copilotz/copilotz/core";
import action from "../../../actions/read-plan/index.ts";
export default defineTool("readPlan", action, {
  name: "readPlan",
  description: "Read the owner-persisted plan before reviewing it.",
});
