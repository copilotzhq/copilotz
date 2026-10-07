import { extractReasoningOutput } from "./reasoning-output.ts";
import type { ToolInvocation, ToolPipelineStage } from "./types.ts";
import {
  COPILOTZ_CONTROL_TAGS,
  escapeRegex,
  normalizeStructuredTagNames,
  STRUCTURAL_LEAK_LITERALS,
} from "./protocol-tags.ts";

/**
 * Recognizes an opening/closing tool-call marker from any known dialect
 * (canonical or native). Used to decide whether an otherwise-unparsed response
 * was actually a malformed tool attempt that should be corrected and retried.
 */
const TOOL_INTENT_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool)\b/i;

const MALFORMED_TOOL_INTENT_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|function_call|function_calls|invoke|parameter|tool_use|tool)\b/i;

const ORPHANED_TOOL_RESULT_TERMINAL_PATTERN =
  /"tool_call_id"\s*:\s*"[^"]+"\s*,\s*"status"\s*:\s*"(?:completed|failed|expired|overwritten)"\s*}\s*$/i;

const ORPHANED_TOOL_RESULT_EVIDENCE_PATTERN =
  /"(?:output|success|error|stoppedEarly|sessionSummary)"\s*:/gi;

const USER_FACING_PROTOCOL_MARKER_PATTERN =
  /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool|tool_result|tool_results|result|continue_after_tool_results|target_ids|malformed_tool_call_recovery|recovery_previous_response_context|recovery_required_action|recovery_tool_call_rules|recovery_problem)\b/i;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

function closeTruncatedJsonContainers(line: string): string | null {
  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of line) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      expectedClosers.push("}");
    } else if (char === "[") {
      expectedClosers.push("]");
    } else if (char === "}" || char === "]") {
      if (expectedClosers.pop() !== char) return null;
    }
  }

  if (inString || expectedClosers.length === 0) return null;
  return line + expectedClosers.reverse().join("");
}

function parseCanonicalToolCallLines(blockContent: string): ToolInvocation[] {
  const lines = blockContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const calls: ToolInvocation[] = [];
  for (const line of lines) {
    const segments = splitPipelineSegments(line);
    if (!segments?.length) return [];
    const stages: ToolPipelineStage[] = [];
    for (const [index, segment] of segments.entries()) {
      let obj: unknown;
      try {
        obj = JSON.parse(segment);
      } catch {
        if (segments.length !== 1) return [];
        const repaired = closeTruncatedJsonContainers(segment);
        if (!repaired) return [];
        try {
          obj = JSON.parse(repaired);
        } catch {
          return [];
        }
      }
      if (!isPlainJsonObject(obj)) return [];
      const keys = Object.keys(obj).sort();
      if (keys.length === 1 && keys[0] === "jq") {
        if (index === 0 || typeof obj.jq !== "string" || !obj.jq.trim()) {
          return [];
        }
        stages.push({ type: "jq", filter: obj.jq });
        continue;
      }
      const canonical = keys.length >= 2 && keys.length <= 4 &&
        keys.includes("arguments") && keys.includes("name") &&
        keys.every((key) =>
          key === "arguments" || key === "name" || key === "tool_call_id" ||
          key === "tool_plan_id"
        );
      if (
        !canonical || typeof obj.name !== "string" ||
        !isPlainJsonObject(obj.arguments)
      ) return [];
      if ("tool_call_id" in obj && typeof obj.tool_call_id !== "string") {
        return [];
      }
      if ("tool_plan_id" in obj && typeof obj.tool_plan_id !== "string") {
        return [];
      }
      stages.push({
        type: "tool",
        // Provider/model IDs are accepted only for transcript compatibility.
        id: crypto.randomUUID(),
        tool: { id: obj.name },
        args: JSON.stringify(obj.arguments),
      });
    }
    const root = stages[0];
    if (!root || root.type !== "tool") return [];
    calls.push({
      id: root.id,
      tool: root.tool,
      args: root.args,
      ...(stages.length > 1
        ? { pipeline: { id: crypto.randomUUID(), stages } }
        : {}),
    });
  }

  return calls;
}

function hasOnlyCompleteJsonPipelineSegments(blockContent: string): boolean {
  const lines = blockContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;

  return lines.every((line) => {
    const segments = splitPipelineSegments(line);
    if (!segments?.length) return false;
    return segments.every((segment) => {
      try {
        JSON.parse(segment);
        return true;
      } catch {
        return false;
      }
    });
  });
}

function splitPipelineSegments(line: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let sawSeparator = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") objectDepth += 1;
    else if (char === "}") objectDepth -= 1;
    else if (char === "[") arrayDepth += 1;
    else if (char === "]") arrayDepth -= 1;
    else if (char === "|" && objectDepth === 0 && arrayDepth === 0) {
      const segment = line.slice(start, index).trim();
      if (!segment) return null;
      segments.push(segment);
      start = index + 1;
      sawSeparator = true;
    }
    if (objectDepth < 0 || arrayDepth < 0) return sawSeparator ? null : [line];
  }
  if (inString || objectDepth !== 0 || arrayDepth !== 0) {
    return sawSeparator ? null : [line];
  }
  const finalSegment = line.slice(start).trim();
  if (!finalSegment) return null;
  segments.push(finalSegment);
  return segments;
}

/** Remove the structural special-token literals that some servers leak. */
export function stripStructuralLeakTokens(text: string): string {
  let out = text;
  for (const literal of STRUCTURAL_LEAK_LITERALS) {
    out = out.split(literal).join("");
  }
  return out;
}

/**
 * Strip recognized tool-call dialect markup (and structural leak tokens) from
 * text. Used both when a dialect call is recovered and as the final safety net
 * on the malformed-tool-call path, so protocol markup never reaches the user.
 */
export function sanitizeUserFacingText(text: string): string {
  let out = extractReasoningOutput(text).visible
    .replace(/<message_timestamp\b[^>]*\/\s*>/gi, "")
    .replace(
      /<message_timestamp\b[^>]*>[\s\S]*?(?:<\/message_timestamp>|$)/gi,
      "",
    )
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, "")
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_results\b[\s\S]*?(?:<\/tool_results>|$)/gi, "")
    .replace(/<tool_result\b[\s\S]*?(?:<\/tool_result>|$)/gi, "")
    .replace(/<result\b[\s\S]*?(?:<\/result>|$)/gi, "")
    .replace(
      /<continue_after_tool_results\b[\s\S]*?(?:<\/continue_after_tool_results>|$)/gi,
      "",
    )
    .replace(
      /<malformed_tool_call_recovery\b[\s\S]*?(?:<\/malformed_tool_call_recovery>|$)/gi,
      "",
    );
  // Remove any residual stray dialect tags (open or close) that survived,
  // e.g. mismatched </tool_calls>, dangling <invoke ...> / <parameter ...>.
  out = out.replace(
    /<\/?(?:[a-z0-9_]+:)?(?:tool_call|tool_calls|function_call|function_calls|invoke|parameter|tool_use|tool|tool_result|tool_results|result|continue_after_tool_results|target_ids|malformed_tool_call_recovery|recovery_previous_response_context|recovery_required_action|recovery_tool_call_rules|recovery_problem|message_timestamp)(?:\b[^>]*)?>/gi,
    "",
  );
  const firstProtocolMarker = out.search(USER_FACING_PROTOCOL_MARKER_PATTERN);
  if (firstProtocolMarker !== -1) {
    out = out.slice(0, firstProtocolMarker);
  }
  return stripStructuralLeakTokens(out).trim();
}

/**
 * Detect whether a response that produced no parsed tool calls nonetheless
 * looks like a (malformed) tool-call attempt. Canonical `<tool_calls>` markup
 * always counts; non-canonical dialects additionally require a known tool name
 * to be present, to avoid treating incidental prose/code as a tool intent.
 */
export function responseHasToolIntent(
  text: string,
  knownToolNames: string[] = [],
): boolean {
  if (!TOOL_INTENT_MARKER_PATTERN.test(text)) return false;
  if (/<\/?tool_calls\b/i.test(text)) return true;
  return knownToolNames.some(
    (name) =>
      typeof name === "string" && name.length > 0 && text.includes(name),
  );
}

export function responseHasMalformedToolCallIntent(
  text: string,
  knownToolNames: string[] = [],
): boolean {
  if (!MALFORMED_TOOL_INTENT_MARKER_PATTERN.test(text)) return false;
  return knownToolNames.length > 0;
}

/**
 * Detect a tagless tail of Copilotz's serialized tool-result envelope.
 *
 * Providers occasionally imitate only the JSON suffix, so neither the
 * `<tool_results>` stop sequence nor tag sanitizer can see it. The reserved
 * call id plus terminal status and multiple result-envelope fields form a
 * deliberately narrow signature that ordinary prose/JSON should not match.
 */
export function responseHasOrphanedToolResult(text: string): boolean {
  const trimmed = text.trim();
  if (!ORPHANED_TOOL_RESULT_TERMINAL_PATTERN.test(trimmed)) return false;
  const evidence = trimmed.match(ORPHANED_TOOL_RESULT_EVIDENCE_PATTERN) ?? [];
  return evidence.length >= 2;
}

/**
 * Parse tool calls from AI response using only the canonical <tool_calls>
 * JSON-lines block. Non-canonical/native tool dialects are intentionally not
 * normalized; callers detect them separately and trigger corrective recovery.
 */
export function parseToolCallsFromResponse(
  response: string,
  knownToolNames: string[] = [],
  options?: { recoverCompleteUnclosed?: boolean },
): { cleanResponse: string; toolCalls: ToolInvocation[] } {
  const toolCalls: ToolInvocation[] = [];
  let cleanResponse = response;

  // Recover only a complete canonical block that is missing its closing tag
  // at the end of an otherwise normally finished response. Partial or unknown
  // calls remain malformed and use the existing corrective retry path.
  const startTag = "<tool_calls>";
  const endTag = "</tool_calls>";
  const startIdx = response.lastIndexOf(startTag);
  const endIdx = response.lastIndexOf(endTag);

  if (startIdx > endIdx) {
    const blockContent = response.slice(startIdx + startTag.length).trim();
    const parsedCalls = parseCanonicalToolCallLines(blockContent);
    const knownNames = new Set(knownToolNames);
    const usesOnlyKnownTools = knownNames.size > 0 &&
      parsedCalls.every((call) =>
        knownNames.has(call.tool.id) &&
        (call.pipeline?.stages ?? []).every((stage) =>
          stage.type !== "tool" || knownNames.has(stage.tool.id)
        )
      );

    if (
      options?.recoverCompleteUnclosed === true &&
      hasOnlyCompleteJsonPipelineSegments(blockContent) &&
      parsedCalls.length > 0 &&
      usesOnlyKnownTools
    ) {
      response = `${response}\n${endTag}`;
      cleanResponse = response;
    } else {
      // Never expose incomplete protocol markup to users.
      response = response.slice(0, startIdx);
      cleanResponse = response;
    }
  }

  // Regex to match <tool_calls> ... </tool_calls> block(s)
  const toolCallsPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/g;
  const matches = [...response.matchAll(toolCallsPattern)];

  for (const match of matches) {
    const blockContent = match[1].trim();
    let parsedCalls = parseCanonicalToolCallLines(blockContent);
    if (parsedCalls.length === 0 && blockContent.includes(startTag)) {
      const restartedBlock = blockContent.slice(
        blockContent.lastIndexOf(startTag) + startTag.length,
      ).trim();
      parsedCalls = parseCanonicalToolCallLines(restartedBlock);
    }
    toolCalls.push(...parsedCalls);

    cleanResponse = cleanResponse.replace(match[0], "").trimStart();
  }

  return { cleanResponse, toolCalls };
}

export function parseInternalControlTagsFromResponse(
  response: string,
): { cleanResponse: string; suppressResponse: boolean } {
  let cleanResponse = response;
  let suppressResponse = false;

  const noResponsePattern =
    /<no_response\s*\/>|<no_response>\s*<\/no_response>/g;
  const hasNoResponse = noResponsePattern.test(cleanResponse);
  noResponsePattern.lastIndex = 0;
  if (hasNoResponse) {
    suppressResponse = true;
    cleanResponse = cleanResponse.replace(noResponsePattern, "");
  }

  cleanResponse = cleanResponse
    .replace(/<tool_results\b[\s\S]*?(?:<\/tool_results>|$)/gi, "")
    .replace(/<tool_result\b[\s\S]*?(?:<\/tool_result>|$)/gi, "")
    .replace(/<result\b[\s\S]*?(?:<\/result>|$)/gi, "")
    .replace(/<continue_after_tool_results\s*\/>/gi, "")
    .replace(
      /<continue_after_tool_results\b[\s\S]*?(?:<\/continue_after_tool_results>|$)/gi,
      "",
    )
    .trim();

  return { cleanResponse, suppressResponse };
}

export function parseTaggedBlocksFromResponse(
  response: string,
  tagNames: string[],
): { cleanResponse: string; extractedTags: Record<string, string[]> } {
  const extractedTags: Record<string, string[]> = {};
  let cleanResponse = response;
  const normalizedTags = normalizeStructuredTagNames(tagNames);

  for (const tagName of normalizedTags) {
    const pattern = new RegExp(
      `<${escapeRegex(tagName)}>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
      "gi",
    );
    const values: string[] = [];

    cleanResponse = cleanResponse.replace(pattern, (_match, inner: string) => {
      const value = typeof inner === "string" ? inner.trim() : "";
      if (value.length > 0) values.push(value);
      return "";
    });

    if (values.length > 0) {
      extractedTags[tagName] = values;
    }
  }

  let earliestDangling:
    | { index: number; tagName: string; openTagEnd: number }
    | null = null;

  for (const tagName of normalizedTags) {
    const openPattern = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`, "gi");
    const closePattern = new RegExp(`</${escapeRegex(tagName)}>`, "gi");
    const opens = [...cleanResponse.matchAll(openPattern)]
      .filter((match) => !(match[0] ?? "").trimEnd().endsWith("/>"));
    const closes = [...cleanResponse.matchAll(closePattern)];
    if (opens.length <= closes.length) continue;

    const danglingOpen = opens[closes.length];
    if (danglingOpen?.index === undefined) continue;
    const openTag = danglingOpen[0] ?? "";
    const candidate = {
      index: danglingOpen.index,
      tagName,
      openTagEnd: danglingOpen.index + openTag.length,
    };
    if (!earliestDangling || candidate.index < earliestDangling.index) {
      earliestDangling = candidate;
    }
  }

  if (earliestDangling) {
    const value = cleanResponse.slice(earliestDangling.openTagEnd).trim();
    if (value.length > 0) {
      extractedTags[earliestDangling.tagName] = [
        ...(extractedTags[earliestDangling.tagName] ?? []),
        value,
      ];
    }
    cleanResponse = cleanResponse.slice(0, earliestDangling.index);
  }

  return { cleanResponse: cleanResponse.trim(), extractedTags };
}

export function findDanglingControlTags(
  response: string,
  tagNames: readonly string[] = COPILOTZ_CONTROL_TAGS,
): string[] {
  const dangling: string[] = [];

  for (const tagName of normalizeStructuredTagNames([...tagNames])) {
    const openPattern = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`, "gi");
    const closePattern = new RegExp(`</${escapeRegex(tagName)}>`, "gi");
    const opens = [...response.matchAll(openPattern)]
      .filter((match) => {
        const raw = match[0] ?? "";
        return !raw.trimEnd().endsWith("/>");
      });
    const closes = [...response.matchAll(closePattern)];
    if (opens.length > closes.length) {
      dangling.push(tagName);
    }
  }

  return dangling;
}

export function stripDanglingControlTail(
  response: string,
  tagNames: readonly string[] = COPILOTZ_CONTROL_TAGS,
): string {
  let earliestDanglingStart = -1;

  for (const tagName of findDanglingControlTags(response, tagNames)) {
    const openTag = `<${tagName}`;
    const index = response.toLowerCase().lastIndexOf(openTag);
    if (index !== -1) {
      earliestDanglingStart = earliestDanglingStart === -1
        ? index
        : Math.min(earliestDanglingStart, index);
    }
  }

  return earliestDanglingStart === -1
    ? response
    : response.slice(0, earliestDanglingStart);
}
