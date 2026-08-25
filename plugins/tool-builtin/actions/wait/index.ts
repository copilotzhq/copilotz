/** Built-in Action that waits with cancellation support.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { waitDefinition } from "../../internal/definitions.ts";

export function createWaitAction(
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
) {
  const definition = waitDefinition(sleep);
  return defineAction({
    id: "copilotz.tools.builtin.wait",
    inputSchema: definition.inputSchema,
    execute(input, context) {
      return definition.execute(input, context);
    },
  });
}
