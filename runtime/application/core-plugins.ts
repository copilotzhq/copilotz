import { createLongTermMemoryPlugin } from "../memory/index.ts";
import {
  createBuiltInToolsPlugin,
  createFinanceToolsPlugin,
  createWebToolsPlugin,
} from "../tools/index.ts";
import { createBundledSkillsPlugin } from "../skills/index.ts";
import { createUsageWorkflowPlugin } from "../usage/index.ts";
import { createScheduledJobsPlugin } from "../schedules/index.ts";
import { createKnowledgePlugin } from "../knowledge/index.ts";
import {
  createAgentAskPlugin,
  createBuiltInLlmProvidersPlugin,
  createTextWorkflowPlugin,
} from "../workflows/index.ts";
import type {
  CopilotzCorePluginOptions,
  CreateCopilotzCorePlugins,
} from "./types.ts";

function enabled<T>(
  value: false | Readonly<T> | undefined,
): Readonly<T> | undefined {
  return value === false ? undefined : value ?? ({} as Readonly<T>);
}

/** Creates the ordered built-in plugin layer used by the public runtime. */
export const createCopilotzCorePlugins: CreateCopilotzCorePlugins = (
  options: false | CopilotzCorePluginOptions = {},
) => {
  if (options === false) return Object.freeze([]);
  const plugins = [];
  const providers = enabled(options.providers);
  const tools = enabled(options.tools);
  const webTools = enabled(options.webTools);
  const finance = enabled(options.finance);
  const skills = enabled(options.skills);
  const memory = enabled(options.memory);
  const usage = enabled(options.usage);
  const text = enabled(options.text);
  const ask = enabled(options.ask);
  const schedules = enabled(options.schedules);
  const knowledge =
    options.knowledge === false || options.knowledge === undefined
      ? undefined
      : options.knowledge;
  if (providers) plugins.push(createBuiltInLlmProvidersPlugin(providers));
  if (tools) plugins.push(createBuiltInToolsPlugin(tools));
  if (webTools) plugins.push(createWebToolsPlugin(webTools));
  if (finance) plugins.push(createFinanceToolsPlugin(finance));
  if (skills) plugins.push(createBundledSkillsPlugin(skills));
  if (memory) plugins.push(createLongTermMemoryPlugin(memory));
  if (usage) plugins.push(createUsageWorkflowPlugin(usage));
  if (text) plugins.push(createTextWorkflowPlugin(text));
  if (ask) plugins.push(createAgentAskPlugin(ask));
  if (schedules) plugins.push(createScheduledJobsPlugin(schedules));
  if (knowledge) plugins.push(createKnowledgePlugin(knowledge));
  return Object.freeze(plugins);
};
