/** Built-in Action that fetches asset metadata.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { fetchAssetDefinition } from "../../internal/definitions.ts";

export function createFetchAssetAction() {
  const definition = fetchAssetDefinition();
  return defineAction({
    id: "copilotz.tools.builtin.fetch_asset",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
