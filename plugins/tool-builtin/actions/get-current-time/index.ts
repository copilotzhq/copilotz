/** Built-in Action that returns the current time.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { getCurrentTimeDefinition } from "../../internal/definitions.ts";

export function createGetCurrentTimeAction(now: () => Date) {
  const definition = getCurrentTimeDefinition(now);
  return defineAction({
    id: "copilotz.tools.builtin.get_current_time",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
