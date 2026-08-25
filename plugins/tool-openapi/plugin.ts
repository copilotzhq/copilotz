/**
 * Composes the generated OpenAPI Action and Tool Resource definitions.
 *
 * @module
 */

import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { ToolResource } from "../tools/authoring/define-tool/index.ts";

/** One operation generated from an OpenAPI declaration. */
export type OpenApiGeneratedTool = Readonly<{
  alias: string;
  action: AnyActionDefinition;
  tool: ToolResource;
}>;

/** Concrete plugin shape produced by OpenAPI discovery. */
export type OpenApiToolsPlugin = CopilotzPlugin<
  string,
  string,
  readonly [],
  Readonly<Record<never, never>>,
  Readonly<Record<string, AnyActionDefinition>>,
  Readonly<Record<never, never>>,
  Readonly<{ tools: Readonly<Record<string, ToolResource>> }>
>;

/**
 * Combines generator-owned definitions into the one OpenAPI Tool plugin.
 * This remains separate so generated operations have one implementation owner.
 */
export function composeOpenApiToolsPlugin(
  options: Readonly<{
    id: string;
    version: string;
    entries: readonly OpenApiGeneratedTool[];
  }>,
): OpenApiToolsPlugin {
  return definePlugin({
    id: options.id,
    version: options.version,
    actions: Object.fromEntries(
      options.entries.map((entry) => [entry.alias, entry.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        options.entries.map((entry) => [entry.alias, entry.tool]),
      ),
    },
  }) as unknown as OpenApiToolsPlugin;
}
