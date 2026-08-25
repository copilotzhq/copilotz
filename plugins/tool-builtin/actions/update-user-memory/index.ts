/** Built-in Action that updates the current human memory.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { updateUserMemoryDefinition } from "../../internal/definitions.ts";

export function createUpdateUserMemoryAction(now: () => Date) {
  const definition = updateUserMemoryDefinition(now);
  return defineAction({
    id: "copilotz.tools.builtin.update_user_memory",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
