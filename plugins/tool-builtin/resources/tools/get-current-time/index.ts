import type { ToolDefinition } from "@copilotz/copilotz/core";
import { getCurrentTimeAction } from "../../../actions/get-current-time/index.ts";
/** Data-only Tool Resource for the current-time Action.
 *
 * @module
 */

import { defineTool } from "../../../../core/authoring/define-tool/index.ts";

export const getCurrentTimeToolResource: ToolDefinition<
  typeof getCurrentTimeAction
> = defineTool({
  ...getCurrentTimeAction,
  ...{
    name: "Get Current Time",
    description: "Get the current date and time in a portable format.",
  },
});

export default getCurrentTimeToolResource;
