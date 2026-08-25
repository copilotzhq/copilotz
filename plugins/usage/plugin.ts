/**
 * Composes the concrete Usage Collection and Processors.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { usageCollection } from "./collections/index.ts";
import type { CreateUsageWorkflowPluginOptions } from "./internal/contracts.ts";
import {
  createLlmUsageProcessor,
  createToolUsageProcessor,
} from "./processors/index.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-usage";
const DEFAULT_PLUGIN_VERSION = "3.0.0";

/** Creates durable accounting as ordinary Collection and Processor resources. */
export function createUsageWorkflowPlugin(
  options: CreateUsageWorkflowPluginOptions = {},
): CopilotzPlugin {
  const processors = options.enabled === false
    ? Object.freeze({})
    : Object.freeze({
      recordLlmUsage: createLlmUsageProcessor(options),
      recordToolUsage: createToolUsageProcessor(options),
    });
  return definePlugin({
    id: options.id ?? DEFAULT_PLUGIN_ID,
    version: options.version ?? DEFAULT_PLUGIN_VERSION,
    collections: { usage: usageCollection },
    processors,
  });
}
