/** Data-only Tool Resource for the wait Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createWaitToolResource(action: AnyActionDefinition) {
  return defineTool("wait", action, {
    name: "Wait",
    description: "Wait for up to 60 seconds, respecting cancellation.",
  });
}
