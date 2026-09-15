import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { persistentTerminalAction } from "../../../actions/persistent-terminal/index.ts";
/**
 * Defines the data-only Persistent Terminal Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";

export const persistentTerminalToolResource: ToolDefinition<
  typeof persistentTerminalAction
> = defineTool({
  ...persistentTerminalAction,
  ...{
    name: "Persistent Terminal",
    description:
      "Scoped persistent terminal. Shell state survives calls within the same worker-local session; agent, project, and tenant scopes control sharing.",
  },
});

export default persistentTerminalToolResource;
