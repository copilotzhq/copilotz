import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { endThreadAction } from "../../../actions/end-thread/index.ts";
/** Data-only Tool Resource for the end-thread Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const endThreadToolResource: ToolDefinition<typeof endThreadAction> =
  defineTool({
    ...endThreadAction,
    ...{
      name: "End Thread",
      description: "Archive the active thread with a public durable summary.",
    },
  });

export default endThreadToolResource;
