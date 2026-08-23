import fetchText from "./fetch-text.ts";
import httpRequest from "./http-request.ts";
import webSearch from "./web-search.ts";
import type { NewTool } from "@copilotz/copilotz/resources";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { WorkflowTool } from "@copilotz/copilotz/tools";

export const WEB_TOOL_IDS = [
  "http_request",
  "fetch_text",
  "web_search",
] as const;

export type WebToolId = typeof WEB_TOOL_IDS[number];

export type CreateWebToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly WebToolId[];
}>;

const definitions: Readonly<Record<WebToolId, NewTool>> = Object.freeze({
  http_request: httpRequest,
  fetch_text: fetchText,
  web_search: webSearch,
});

function workflowTool(id: WebToolId): WorkflowTool {
  const value = definitions[id];
  if (typeof value.execute !== "function") {
    throw new TypeError(`Web tool '${id}' has no executor.`);
  }
  return Object.freeze({
    ...value,
    id: value.id || value.key,
    execute: value.execute,
  }) as WorkflowTool;
}

/** Provides Web API-based network tools without filesystem or process access. */
export function createWebToolsPlugin(
  options: CreateWebToolsPluginOptions = {},
): CopilotzPlugin {
  const include = options.include ?? WEB_TOOL_IDS;
  if (new Set(include).size !== include.length) {
    throw new TypeError("Web tool selection contains duplicate IDs.");
  }
  const tools = include.map((id) => {
    if (!WEB_TOOL_IDS.includes(id)) {
      throw new TypeError(`Unknown Web tool '${id}'.`);
    }
    return workflowTool(id);
  });
  return definePlugin({
    id: options.id ?? "@copilotz/web-tools",
    version: options.version ?? "3.0.0",
    resources: {
      tools: Object.fromEntries(tools.map((tool) => [tool.key, tool])),
    },
  });
}
