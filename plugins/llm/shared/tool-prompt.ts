import type { ToolDefinition } from "./types.ts";

/** The single Copilotz tool grammar, including executable examples. */
export const TOOL_PROTOCOL = String
  .raw`Call tools using one <tool_calls> block. A tool stage is {"name":"tool_name","arguments":{...}}; arguments must be an object. Use tool names and arguments from the catalog.

Write each chain on one line; lines run independently in parallel. Within a chain, | runs stages sequentially. The previous stage's result is deep-merged into the next tool's arguments: objects merge recursively; explicit arguments replace other values, including arrays. Insert {"jq":"filter"} to reshape a result into one arguments object before the next tool.

Results arrive in <tool_results> on your next turn. Use those results before answering questions that depend on them; never write tool results yourself. Visible text may accompany tool calls. Without a tool call, your turn ends.

Examples below assume get_location returns {latitude, longitude} and get_weather accepts those coordinates plus units and returns {temperature, condition}. Use the actual catalog in your task.

Single call:
<tool_calls>
{"name":"get_weather","arguments":{"latitude":51.51,"longitude":-0.13,"units":"celsius"}}
</tool_calls>

Sequential calls (location output supplies weather coordinates):
<tool_calls>
{"name":"get_location","arguments":{"city":"London"}} | {"name":"get_weather","arguments":{"units":"celsius"}}
</tool_calls>

Sequential calls with a jq transformation:
<tool_calls>
{"name":"get_weather","arguments":{"latitude":51.51,"longitude":-0.13,"units":"celsius"}} | {"jq":"{text: (.temperature | tostring) + \" C, \" + .condition}"} | {"name":"save_note","arguments":{"title":"London weather"}}
</tool_calls>

Parallel calls:
<tool_calls>
{"name":"get_location","arguments":{"city":"London"}}
{"name":"get_location","arguments":{"city":"Tokyo"}}
</tool_calls>

Mixed parallel and sequential calls:
<tool_calls>
{"name":"get_location","arguments":{"city":"London"}} | {"name":"get_weather","arguments":{"units":"celsius"}} | {"jq":"{text: (.temperature | tostring) + \" C, \" + .condition}"} | {"name":"save_note","arguments":{"title":"London weather"}}
{"name":"get_location","arguments":{"city":"Tokyo"}} | {"name":"get_weather","arguments":{"units":"celsius"}}
</tool_calls>`;

export function generateToolSystemPrompt(tools: ToolDefinition[]): string {
  const catalog = tools.map(({ function: tool }) =>
    [
      `### ${tool.name}`,
      tool.description,
      "```typescript\n" + tool.inputTypes.trim() + "\n```",
    ].join("\n\n")
  ).join("\n\n");
  return `${TOOL_PROTOCOL}\n\n=== TOOL CATALOG ===\n\n${catalog}`;
}
