import { defineTool } from "@copilotz/copilotz/core";
import action from "../../../actions/save-draft/index.ts";
export default defineTool("saveDraft", action, {
  name: "saveDraft",
  description:
    "Save the coordinator draft with the time returned by the built-in clock.",
});
