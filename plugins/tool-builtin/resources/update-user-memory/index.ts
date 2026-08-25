/** Data-only Tool Resource for the human-memory Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createUpdateUserMemoryToolResource(
  action: AnyActionDefinition,
) {
  return defineTool("update_user_memory", action, {
    name: "Update User Memory",
    description:
      "Add or remove a durable memory item on the current human participant.",
  });
}
