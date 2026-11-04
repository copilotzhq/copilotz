/**
 * The MCP plugin's contract: what other plugins and apps may import: the
 * shape of a line the app declares, of how it knows who's calling
 * (`McpCaller`) and of the plugin's settings (the `mcp` resource), and its
 * limits by default (`MCP_LIMITS`). They reach the rest
 * by name: its route (`/mcp/<line>`), and the step each call writes in its
 * chat (a private `message` from the line's `client`).
 */
export {
  LIMITS as MCP_LIMITS,
  type McpCaller,
  type McpLimits,
  type McpLine,
  type McpSettings,
  type McpTool,
} from "./shared/settings.ts";
