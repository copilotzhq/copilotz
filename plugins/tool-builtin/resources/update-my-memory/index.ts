/** Data-only Tool Resource for the Agent-memory Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createUpdateMyMemoryToolResource(action: AnyActionDefinition) {
  return defineTool("update_my_memory", action, {
    name: "Update My Memory",
    description: "Update the calling agent participant's durable metadata.",
  });
}
