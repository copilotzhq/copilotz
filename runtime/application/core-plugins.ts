import { createLongTermMemoryPlugin } from "../memory/index.ts";
import {
  createBuiltInToolsPlugin,
  createFinanceToolsPlugin,
  createWebToolsPlugin,
} from "../tools/index.ts";
import { createUsageWorkflowPlugin } from "../usage/index.ts";
import { createScheduledJobsPlugin } from "../schedules/index.ts";
import { createKnowledgePlugin } from "../knowledge/index.ts";
import type {
  CopilotzCorePluginOptions,
  CreateCopilotzCorePlugins,
} from "./types.ts";

function enabled<T>(
  value: false | Readonly<T> | undefined,
  enabledByDefault: boolean,
): Readonly<T> | undefined {
  if (value === false) return undefined;
  if (value !== undefined) return value;
  return enabledByDefault ? ({} as Readonly<T>) : undefined;
}

/** Creates the ordered built-in plugin layer used by the public runtime. */
export const createCopilotzCorePlugins: CreateCopilotzCorePlugins = (
  options: false | CopilotzCorePluginOptions = {},
  _defaults = {},
) => {
  if (options === false) return Object.freeze([]);
  const plugins = [];
  const tools = enabled(options.tools, false);
  const webTools = enabled(options.webTools, false);
  const finance = enabled(options.finance, false);
  const memory = enabled(options.memory, false);
  const usage = enabled(options.usage, false);
  const schedules = enabled(options.schedules, false);
  const knowledge =
    options.knowledge === false || options.knowledge === undefined
      ? undefined
      : options.knowledge;
  if (tools) plugins.push(createBuiltInToolsPlugin(tools));
  if (webTools) plugins.push(createWebToolsPlugin(webTools));
  if (finance) plugins.push(createFinanceToolsPlugin(finance));
  if (memory) plugins.push(createLongTermMemoryPlugin(memory));
  if (usage) plugins.push(createUsageWorkflowPlugin(usage));
  if (schedules) plugins.push(createScheduledJobsPlugin(schedules));
  if (knowledge) plugins.push(createKnowledgePlugin(knowledge));
  return Object.freeze(plugins);
};
