/** Public names for generated plugin composition. @module */
export { default as webToolsPlugin } from "./plugin.generated.ts";
export const WEB_TOOL_IDS = [
  "fetch_text",
  "http_request",
  "web_search",
] as const;
export type WebToolId = typeof WEB_TOOL_IDS[number];
