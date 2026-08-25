/** Built-in Action that validates an existing asset reference.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { saveAssetDefinition } from "../../internal/definitions.ts";

export function createSaveAssetAction() {
  const definition = saveAssetDefinition();
  return defineAction({
    id: "copilotz.tools.builtin.save_asset",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
