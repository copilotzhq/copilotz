/** Built-in Action that archives the current thread.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { endThreadDefinition } from "../../internal/definitions.ts";

export function createEndThreadAction() {
  const definition = endThreadDefinition();
  return defineAction({
    id: "copilotz.tools.builtin.end_thread",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
