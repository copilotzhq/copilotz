import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { waitAction } from "../../../actions/wait/index.ts";
/** Data-only Tool Resource for the wait Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const waitToolResource: ToolDefinition<typeof waitAction> = defineTool({
  ...waitAction,
  ...{
    name: "Wait",
    description: "Wait for up to 60 seconds, respecting cancellation.",
  },
});

export default waitToolResource;
