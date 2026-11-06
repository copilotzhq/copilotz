/**
 * The MCP plugin's contract: what other plugins and apps may import: the
 * shape of a server the app declares and of the plugin's settings (the
 * `mcp` resource), and its limits by default (`MCP_LIMITS`). They reach the
 * rest by name: its route (`/mcp/<name>`), and the step each call writes in
 * its chat (a private `message` from the server's `client`).
 */
export {
  type DeclaredServer,
  LIMITS as MCP_LIMITS,
  type McpLimits,
  type McpSettings,
  type McpTool,
} from "./shared/settings.ts";
