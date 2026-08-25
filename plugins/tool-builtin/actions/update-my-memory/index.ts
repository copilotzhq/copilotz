/** Built-in Action that updates the calling Agent memory.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { updateMyMemoryDefinition } from "../../internal/definitions.ts";

export function createUpdateMyMemoryAction() {
  const definition = updateMyMemoryDefinition();
  return defineAction({
    id: "copilotz.tools.builtin.update_my_memory",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
