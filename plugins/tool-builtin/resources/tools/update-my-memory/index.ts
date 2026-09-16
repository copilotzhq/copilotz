import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { updateMyMemoryAction } from "../../../actions/update-my-memory/index.ts";
/** Data-only Tool Resource for the Agent-memory Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const updateMyMemoryToolResource: ToolDefinition<
  typeof updateMyMemoryAction
> = defineTool({
  ...updateMyMemoryAction,
  ...{
    name: "Update My Memory",
    description: "Update the calling agent participant's durable metadata.",
  },
});

export default updateMyMemoryToolResource;
