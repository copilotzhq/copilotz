/**
 * Defines the data-only Persistent Terminal Tool Resource.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";

export function createPersistentTerminalToolResource<Alias extends string>(
  alias: Alias,
  action: AnyActionDefinition,
): ToolResource<Alias> {
  return defineTool(alias, action, {
    name: "Persistent Terminal",
    description:
      "Scoped persistent terminal. Shell state survives calls within the same worker-local session; agent, project, and tenant scopes control sharing.",
  });
}
