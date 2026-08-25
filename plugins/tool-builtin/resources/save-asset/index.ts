/** Data-only Tool Resource for the save-asset Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createSaveAssetToolResource(action: AnyActionDefinition) {
  return defineTool("save_asset", action, {
    name: "Save Asset",
    description:
      "Validate and return a canonical Copilotz ContentRef for an existing asset.",
  });
}
