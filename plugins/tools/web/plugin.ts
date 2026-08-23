import { fetchTextAction, fetchTextTool } from "./fetch-text.ts";
import { httpRequestAction, httpRequestTool } from "./http-request.ts";
import { webSearchAction, webSearchTool } from "./web-search.ts";
import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import type { ToolResource } from "../contracts.ts";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";

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

const definitions: Readonly<
  Record<
    WebToolId,
    Readonly<{ action: AnyActionDefinition; tool: ToolResource }>
  >
> = Object.freeze({
  http_request: { action: httpRequestAction, tool: httpRequestTool },
  fetch_text: { action: fetchTextAction, tool: fetchTextTool },
  web_search: { action: webSearchAction, tool: webSearchTool },
});

/** Provides Web API-based network tools without filesystem or process access. */
export function createWebToolsPlugin(
  options: CreateWebToolsPluginOptions = {},
): CopilotzPlugin {
  const include = options.include ?? WEB_TOOL_IDS;
  if (new Set(include).size !== include.length) {
    throw new TypeError("Web tool selection contains duplicate IDs.");
  }
  const selected = include.map((id) => {
    if (!WEB_TOOL_IDS.includes(id)) {
      throw new TypeError(`Unknown Web tool '${id}'.`);
    }
    return [id, definitions[id]] as const;
  });
  return definePlugin({
    id: options.id ?? "@copilotz/web-tools",
    version: options.version ?? "3.0.0",
    actions: Object.fromEntries(
      selected.map(([alias, definition]) => [alias, definition.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        selected.map(([alias, definition]) => [alias, definition.tool]),
      ),
    },
  });
}
