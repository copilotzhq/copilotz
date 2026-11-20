/**
 * What a native agent may do, when it asks (`session/request_permission`):
 * call the agent's own tools (the session's MCP server's), and nothing
 * else. Its own tools (files, commands, the web) are refused: they're off
 * in its settings too, and what it asks about that isn't plainly one of the
 * agent's tools is refused as well (fail closed).
 *
 * ACP says no more of a tool call than its id, title and kind, so one is
 * the agent's when its kind is unsaid or `other` (never reading, editing,
 * running or fetching), and its title or id names one of the session's
 * tools, alone or with the server's name (`copilotz/lookup`,
 * `mcp__copilotz__lookup`, `lookup (copilotz MCP Server)`, `lookup-1712…`).
 */
import { MCP_NAME } from "./mcp.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** What the agent asked about, as `tools` names it, if it's one of them. */
function toolOf(call: Json, tools: Set<string>): string | undefined {
  if (call?.kind !== undefined && call.kind !== null && call.kind !== "other") return undefined;
  const server = MCP_NAME;
  const names = [call?.title, call?.toolCallId].filter((n) => typeof n === "string") as string[];
  for (const said of names) {
    const forms = [
      said,
      said.replace(new RegExp(`^(?:mcp__)?${server}(?:__|/|\\.|:)`), ""),
      said.replace(new RegExp(`\\s*\\(${server}(?: MCP Server)?\\)$`, "i"), ""),
      said.replace(/-\d+$/, ""),
    ];
    for (const form of forms) if (tools.has(form)) return form;
  }
}

/** The answer to a permission request: allowed once for the agent's tools, else refused. */
export function permit(
  params: Json,
  tools: Set<string>,
  log: (line: string) => void,
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const tool = toolOf(params?.toolCall, tools);
  const options: Json[] = Array.isArray(params?.options) ? params.options : [];
  const kinds = tool ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  if (!tool) log(`refused: ${String(params?.toolCall?.title ?? "a tool call").slice(0, 120)}`);
  for (const kind of kinds) {
    const option = options.find((o) => o?.kind === kind && typeof o.optionId === "string");
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
