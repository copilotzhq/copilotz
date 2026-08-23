import { createFinanceTool, type CreateFinanceToolOptions } from "./index.ts";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { WorkflowTool } from "../internal/types.ts";

export type CreateFinanceToolsPluginOptions =
  & CreateFinanceToolOptions
  & Readonly<{ id?: string; version?: string }>;

/** Provides the finance capability as one logical, factory-created tool. */
export function createFinanceToolsPlugin(
  options: CreateFinanceToolsPluginOptions = {},
): CopilotzPlugin {
  const tool = createFinanceTool({ getProvider: options.getProvider });
  if (typeof tool.execute !== "function") {
    throw new TypeError("Finance tool has no executor.");
  }
  const workflowTool = Object.freeze({
    ...tool,
    id: tool.id || tool.key,
    execute: tool.execute,
  }) as WorkflowTool;
  return definePlugin({
    id: options.id ?? "@copilotz/finance-tools",
    version: options.version ?? "3.0.0",
    resources: { tools: { [workflowTool.key]: workflowTool } },
  });
}
