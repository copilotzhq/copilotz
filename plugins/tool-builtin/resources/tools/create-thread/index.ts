import type { ToolDefinition } from "@copilotz/copilotz/core";
import { createThreadAction } from "../../../actions/create-thread/index.ts";
/** Data-only Tool Resource for the create-thread Action.
 *
 * @module
 */

import { defineTool } from "../../../../core/authoring/define-tool/index.ts";

export const createThreadToolResource: ToolDefinition<
  typeof createThreadAction
> = defineTool({
  ...createThreadAction,
  ...{
    name: "Create Thread",
    description:
      "Create an explicitly separate public conversation and start it through normal durable routing.",
  },
});

export default createThreadToolResource;
