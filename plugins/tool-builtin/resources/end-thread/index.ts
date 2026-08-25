/** Data-only Tool Resource for the end-thread Action.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";

export function createEndThreadToolResource(action: AnyActionDefinition) {
  return defineTool("end_thread", action, {
    name: "End Thread",
    description: "Archive the active thread with a public durable summary.",
  });
}
