import { createLongTermMemoryPlugin } from "../memory/index.ts";
import {
  createBuiltInToolsPlugin,
  createFinanceToolsPlugin,
  createWebToolsPlugin,
} from "../tools/index.ts";
import { createScheduledJobsPlugin } from "../schedules/index.ts";
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
  const schedules = enabled(options.schedules, false);
  if (tools) plugins.push(createBuiltInToolsPlugin(tools));
  if (webTools) plugins.push(createWebToolsPlugin(webTools));
  if (finance) plugins.push(createFinanceToolsPlugin(finance));
  if (memory) plugins.push(createLongTermMemoryPlugin(memory));
  if (schedules) plugins.push(createScheduledJobsPlugin(schedules));
  return Object.freeze(plugins);
};
