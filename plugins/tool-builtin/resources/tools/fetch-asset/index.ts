import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { fetchAssetAction } from "../../../actions/fetch-asset/index.ts";
/** Data-only Tool Resource for the fetch-asset Action.
 *
 * @module
 */

import { defineTool } from "../../../../tools/authoring/define-tool/index.ts";

export const fetchAssetToolResource: ToolDefinition<typeof fetchAssetAction> =
  defineTool({
    ...fetchAssetAction,
    ...{
      name: "Fetch Asset",
      description:
        "Return a canonical ContentRef and metadata by asset ID or asset:// reference.",
    },
  });

export default fetchAssetToolResource;
