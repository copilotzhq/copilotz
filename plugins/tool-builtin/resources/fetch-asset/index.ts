/** Data-only Tool Resource for the fetch-asset Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createFetchAssetToolResource(action: AnyActionDefinition) {
  return defineTool("fetch_asset", action, {
    name: "Fetch Asset",
    description:
      "Return a canonical ContentRef and metadata by asset ID or asset:// reference.",
  });
}
