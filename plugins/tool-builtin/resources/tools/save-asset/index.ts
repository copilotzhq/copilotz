import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { saveAssetAction } from "../../../actions/save-asset/index.ts";
/** Data-only Tool Resource for the save-asset Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const saveAssetToolResource: ToolDefinition<typeof saveAssetAction> =
  defineTool({
    ...saveAssetAction,
    ...{
      name: "Save Asset",
      description:
        "Validate and return a canonical Copilotz ContentRef for an existing asset.",
    },
  });

export default saveAssetToolResource;
