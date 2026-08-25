/**
 * Composes the concrete Finance Tool Action and Tool Resource.
 *
 * @module
 */

import {
  createFinanceAction,
  type CreateFinanceActionOptions,
} from "./actions/index.ts";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { financeToolResource } from "./resources/index.ts";

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
  Readonly<{
    tools: Readonly<{ finance: ReturnType<typeof financeToolResource> }>;
  }>,
  EmptyMap
>;

function financeToolsPlugin(
  options: CreateFinanceToolsPluginOptions,
): FinanceToolsPlugin {
  const action = createFinanceAction({ getProvider: options.getProvider });
  const tool = financeToolResource(action);
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
