import type { ToolDefinition, ToolSystemPromptVariant } from "./types.ts";

// =============================================================================
// STANDARDIZED TOOL CALLING FUNCTIONS
// =============================================================================

export function generateToolSystemPrompt(
  tools: ToolDefinition[],
  variant: ToolSystemPromptVariant = "useful-visible-contract",
): string {
  return generateToolSystemPromptVariant(tools, variant);
}

function renderToolCatalog(tools: ToolDefinition[]): string {
  return tools.map((tool) => {
    const { name, description, inputTypes } = tool.function;
    return [
      `### ${name}`,
      "",
      description,
      "",
      "```typescript",
      inputTypes.trim(),
      "```",
    ].join("\n");
  }).join("\n\n");
}

export function generateToolSystemPromptVariant(
  tools: ToolDefinition[],
  variant: ToolSystemPromptVariant = "baseline",
): string {
  const toolCatalog = renderToolCatalog(tools);
  const runLifecycleRule =
    "A response without a tool call ends the current run. Never promise a future action unless its tool call is included in that same response. If you cannot call the tool now, state the blocker instead of promising the action.";

  if (variant === "strict-minimal") {
    return `
=== TOOL USAGE ===

You have access to tools. Copilotz, not the provider, executes tools.

When a tool is needed, emit exactly one <tool_calls> block. Optional visible text may appear before or after it. Inside the block, emit one JSON object per line:
{ "name": "tool_name", "arguments": { ... } }

Rules:
- Each object must have exactly "name" and "arguments".
- "arguments" must be a JSON object.
- New lines run in parallel; stages joined by | run sequentially.
- For parallel calls, write each complete JSON object on its own line. Do not wrap calls in an array or put commas between objects. Array-valued arguments inside an object are allowed.
- Use { "jq": "filter" } to reshape a prior stage's JSON before the next tool.
- Use only tool names from the catalog.
- Do not use provider-native tool syntax or any non-Copilotz tool format.
- Do not emit <tool_results>; Copilotz provides tool results as external input in a later user turn.
- ${runLifecycleRule}

Example:
Sure — checking that now.

<tool_calls>
{ "name": "tool_name", "arguments": { "key": "value" } }
</tool_calls>

Parallel example (use only tools and arguments from your actual catalog):
<tool_calls>
{"name":"tool_name","arguments":{"key":"first"}}
{"name":"tool_name","arguments":{"key":"second"}}
</tool_calls>
These are two independent calls. There is no surrounding array and no comma between the lines.

=== TOOL CATALOG (read-only) ===

${toolCatalog}`;
  }

  const extraRules: string[] = [runLifecycleRule];
  if (variant === "tool-only-turn") {
    extraRules.push(
      "When calling tools, emit only the <tool_calls> block in that assistant message. Do not add acknowledgements, explanations, markdown, or filler text before or after the block.",
    );
  }
  if (variant === "tool-call-contract") {
    extraRules.push(
      "If you call tools, the assistant message must contain only the <tool_calls> block. Do not include acknowledgements, status updates, summaries, markdown, or final answers in that same assistant message.",
    );
    extraRules.push(
      "Only include visible text before a tool call when the user explicitly asks you to explain before acting.",
    );
    extraRules.push(
      "If the user asks you to use a tool, call the tool before answering even when you already know the answer. Never include the final answer in the same assistant message as a tool call.",
    );
  }
  if (variant === "useful-visible-contract") {
    extraRules.push(
      'Visible text accompanying a tool call is allowed only when it is useful to the user, such as a brief requested explanation. Merely saying which tools you will call is not useful. Do not emit generic acknowledgements, status narration, or filler such as "Sure", "I\'ll call the tool", or "running that now".',
    );
    extraRules.push(
      "When a tool result is needed before answering, do not include the final answer in the same assistant message as the tool call. Wait for it will be provided as <tool_results> in next turn, then answer from those results.",
    );
  }
  if (variant === "lifecycle-explicit") {
    extraRules.push(
      "Tool-calling is a loop: you emit <tool_calls>, Copilotz executes those calls, Copilotz later inserts <tool_results>, and you then use those results to continue or answer. Do not invent tool results yourself.",
    );
  }
  const ruleOne = variant === "baseline" || variant === "no-visible-ack"
    ? "You may talk to the human normally and call tools in the same response. Visible text may appear before or after <tool_calls>."
    : "You may answer the human normally when no tool is needed. When a tool is needed, include <tool_calls> in the same response; unless a later rule requires tool-only output, visible text may appear before or after it.";
  const extraRuleText = extraRules.length > 0
    ? "\n" +
      extraRules.map((rule, index) => `${4 + index}. ${rule}`).join("\n") +
      "\n"
    : "";
  const exampleRuleNumber = 4 + extraRules.length;
  const nextRuleNumber = exampleRuleNumber + 1;

  return `

=== THINKING ===

Your previous thinking traces may appear as <think> ... </think> blocks. Do not include them in your response.

=== RESPONSE STRUCTURE ===

When a response includes visible text and tool calls, the visible text may appear before or after the single <tool_calls> ... </tool_calls> block.
Copilotz inserts <tool_results> later in user turns; never emit tool results yourself.
If no visible reply is needed, respond with <no_response/>.

=== TOOL USAGE ===

In this environment you have access to a set of tools you can use to answer the user's question.

=== RULES ===

1. ${ruleOne}
2. To call a tool, emit one JSON object per line between a single <tool_calls> ... </tool_calls> block.
   - Each object has exactly two keys: "name" (string) and "arguments" (object). No other keys.
   - "arguments" is a JSON object and may contain nested objects/arrays.
   - New lines run in parallel.
   - Join JSON stages with | on the same line to run them sequentially.
   - A transform stage has exactly one key: { "jq": "filter" }.
   - A piped object is deep-merged into the next tool's arguments; explicit arguments in the later stage win.
   - If a piped value is not an object, use jq to shape it into one before the next tool.
3. Use ONLY this <tool_calls> JSON format for tool calls.
${extraRuleText}${exampleRuleNumber}. 

##### Example (note the nested arguments object):

>
> Sure. Let me check the weather in New York and Tokyo for today.
>
> <tool_calls>
> { "name": "get_weather", "arguments": { "city": "New York", "config": { "units": "celsius" } } }
> { "name": "get_weather", "arguments": { "city": "Tokyo", "config": { "units": "celsius" } } }
> </tool_calls>
>

${nextRuleNumber}. Tool outputs may appear later as <tool_results> blocks in user turns. Treat them as returned execution results and never generate <tool_results>, <tool_result>, <result>, <target_ids>, or <continue_after_tool_results> yourself.
${nextRuleNumber + 1}

=== TOOL CATALOG (read-only) ===

${toolCatalog}`;
}
