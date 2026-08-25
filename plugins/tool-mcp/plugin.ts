/**
 * Composes generated MCP Actions and Tool Resources into one plugin.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { ToolResource } from "../tools/authoring/define-tool/index.ts";

export type McpPluginEntry = Readonly<{
  alias: string;
  action: AnyActionDefinition;
  tool: ToolResource;
}>;

/** Packages a completed MCP discovery snapshot for registry composition. */
export function composeMcpToolsPlugin(
  options: Readonly<{ id?: string; version?: string }>,
  entries: readonly McpPluginEntry[],
): CopilotzPlugin {
  return definePlugin({
    id: options.id ?? "@copilotz/mcp-tools",
    version: options.version ?? "3.0.0",
    actions: Object.fromEntries(
      entries.map((entry) => [entry.alias, entry.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        entries.map((entry) => [entry.alias, entry.tool]),
      ),
    },
  });
}
