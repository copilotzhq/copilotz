import {
  createFinanceAction,
  type CreateFinanceActionOptions,
  FINANCE_TOOL_DESCRIPTION,
  FINANCE_TOOL_NAME,
} from "./index.ts";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { defineTool, type ToolResource } from "../contracts.ts";

export type CreateFinanceToolsPluginOptions =
  & CreateFinanceActionOptions
  & Readonly<{ id?: string; version?: string }>;

type EmptyMap = Readonly<Record<never, never>>;
type FinanceToolsPlugin = CopilotzPlugin<
  string,
  string,
  readonly [],
  EmptyMap,
  Readonly<{ finance: ReturnType<typeof createFinanceAction> }>,
  EmptyMap,
  Readonly<{ tools: Readonly<{ finance: ToolResource<"finance"> }> }>,
  EmptyMap
>;

function financeToolsPlugin(
  options: CreateFinanceToolsPluginOptions,
): FinanceToolsPlugin {
  const action = createFinanceAction({ getProvider: options.getProvider });
  const tool = defineTool("finance", action, {
    name: FINANCE_TOOL_NAME,
    description: FINANCE_TOOL_DESCRIPTION,
  });
  return definePlugin({
    id: options.id ?? "@copilotz/finance-tools",
    version: options.version ?? "3.0.0",
    actions: { finance: action },
    resources: { tools: { finance: tool } },
  });
}

/** Provides the finance capability as one logical, factory-created tool. */
export function createFinanceToolsPlugin(
  options: CreateFinanceToolsPluginOptions = {},
): FinanceToolsPlugin {
  return financeToolsPlugin(options);
}
