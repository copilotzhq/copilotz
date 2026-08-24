import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  defineTool,
  type ToolDefinition,
  type ToolResource,
} from "./contracts.ts";

type ToolActionMap<TTools extends Readonly<Record<string, ToolDefinition>>> =
  Readonly<
    {
      [TAlias in keyof TTools]: TTools[TAlias] extends ToolDefinition<
        infer TAction
      > ? TAction
        : never;
    }
  >;

type ToolResourceMap<TTools extends Readonly<Record<string, ToolDefinition>>> =
  Readonly<
    {
      [TAlias in keyof TTools]: ToolResource<Extract<TAlias, string>>;
    }
  >;

export type ToolsPlugin<
  TTools extends Readonly<Record<string, ToolDefinition>>,
> = CopilotzPlugin<
  string,
  string,
  readonly [],
  Readonly<Record<never, never>>,
  ToolActionMap<TTools>,
  Readonly<Record<never, never>>,
  Readonly<{ tools: ToolResourceMap<TTools> }>
>;

export type CreateToolsPluginOptions<
  TTools extends Readonly<Record<string, ToolDefinition>> = Readonly<
    Record<string, ToolDefinition>
  >,
> = Readonly<{
  id?: string;
  version?: string;
  tools: TTools;
}>;

/**
 * Composes object-form Tool definitions into native Actions and matching
 * data-only Tool Resources. Map keys are the canonical Action aliases.
 */
export function createToolsPlugin<
  const TTools extends Readonly<Record<string, ToolDefinition>>,
>(options: CreateToolsPluginOptions<TTools>): ToolsPlugin<TTools> {
  if (
    !options || !options.tools || typeof options.tools !== "object" ||
    Array.isArray(options.tools)
  ) {
    throw new TypeError("Tools plugin requires a tools alias map.");
  }
  const actions: Record<string, ToolDefinition["action"]> = {};
  const tools: Record<string, ToolResource> = {};
  const actionIds = new Set<string>();
  for (const [alias, definition] of Object.entries(options.tools)) {
    if (
      !definition || typeof definition !== "object" ||
      !("action" in definition) || !("presentation" in definition)
    ) {
      throw new TypeError(
        `Tools plugin alias '${alias}' has an invalid definition.`,
      );
    }
    const action = definition.action;
    if (actionIds.has(action.id)) {
      throw new TypeError(`Tools plugin Action id collision '${action.id}'.`);
    }
    actionIds.add(action.id);
    actions[alias] = action;
    tools[alias] = defineTool(alias, action, definition.presentation);
  }
  return definePlugin({
    id: options.id ?? "@copilotz/tools",
    version: options.version ?? "1.0.0",
    actions,
    resources: { tools },
  }) as unknown as ToolsPlugin<TTools>;
}
