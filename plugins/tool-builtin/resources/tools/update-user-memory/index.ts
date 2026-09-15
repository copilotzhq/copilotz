import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { updateUserMemoryAction } from "../../../actions/update-user-memory/index.ts";
/** Data-only Tool Resource for the human-memory Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const updateUserMemoryToolResource: ToolDefinition<
  typeof updateUserMemoryAction
> = defineTool({
  ...updateUserMemoryAction,
  ...{
    name: "Update User Memory",
    description:
      "Add or remove a durable memory item on the current human participant.",
  },
});

export default updateUserMemoryToolResource;
