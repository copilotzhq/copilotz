/** Built-in Action that creates a separate durable thread.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { createThreadDefinition } from "../../internal/definitions.ts";

export function createCreateThreadAction() {
  const definition = createThreadDefinition();
  return defineAction({
    id: "copilotz.tools.builtin.create_thread",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
