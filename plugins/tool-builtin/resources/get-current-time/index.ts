/** Data-only Tool Resource for the current-time Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createGetCurrentTimeToolResource(action: AnyActionDefinition) {
  return defineTool("get_current_time", action, {
    name: "Get Current Time",
    description: "Get the current date and time in a portable format.",
  });
}
