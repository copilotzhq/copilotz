/** Data-only Tool Resource for the create-thread Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createCreateThreadToolResource(action: AnyActionDefinition) {
  return defineTool("create_thread", action, {
    name: "Create Thread",
    description:
      "Create an explicitly separate public conversation and start it through normal durable routing.",
  });
}
