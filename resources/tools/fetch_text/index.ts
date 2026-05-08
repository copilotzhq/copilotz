interface FetchTextParams {
  url: string;
  timeout?: number;
  maxChars?: number;
  contains?: string;
  extractRegex?: string;
  extractRegexFlags?: string;
  extractGroup?: number | string;
  mode?: "full" | "first_match" | "all_matches" | "lines_matching";
}

const DEFAULT_MAX_CHARS = 100_000;
const MAX_CHARS_LIMIT = 1_000_000;
const MAX_REGEX_INPUT_CHARS = 200_000;
const MAX_MATCHES = 50;

function clampMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.min(Math.floor(value), MAX_CHARS_LIMIT);
}

function truncateText(
  text: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: text.slice(0, maxChars), truncated: true };
}

function validateRegexFlags(flags = ""): string {
  if (!/^[dgimsuvy]*$/.test(flags)) {
    throw new Error("Invalid regex flags.");
  }
  return Array.from(new Set(flags.split(""))).join("");
}

function selectRegexGroup(
  match: RegExpMatchArray,
  group?: number | string,
): string {
  if (typeof group === "number") return match[group] ?? "";
  if (typeof group === "string" && group.length > 0) {
    return match.groups?.[group] ?? "";
  }
  return match[0] ?? "";
}

export function shapeFetchedText(
  text: string,
  params: Pick<
    FetchTextParams,
    | "contains"
    | "extractRegex"
    | "extractRegexFlags"
    | "extractGroup"
    | "mode"
    | "maxChars"
  >,
): {
  content: string;
  originalLength: number;
  returnedLength: number;
  truncated: boolean;
  extraction?: Record<string, unknown>;
} {
  const maxChars = clampMaxChars(params.maxChars);
  const requestedMode = params.mode ??
    (params.extractRegex ? "all_matches" : "full");
  const mode = params.extractRegex && requestedMode === "full"
    ? "all_matches"
    : requestedMode;
  let content = text;
  let extraction: Record<string, unknown> | undefined;

  if (params.contains) {
    const needle = params.contains.toLowerCase();
    const lines = text.split(/\r?\n/).filter((line) =>
      line.toLowerCase().includes(needle)
    );
    content = lines.join("\n");
    extraction = {
      type: "contains",
      value: params.contains,
      matches: lines.length,
    };
  }

  if (params.extractRegex) {
    const input = content.slice(0, MAX_REGEX_INPUT_CHARS);
    const regexFlags = validateRegexFlags(params.extractRegexFlags);
    const flags = mode === "all_matches" || mode === "lines_matching"
      ? regexFlags.includes("g") ? regexFlags : `${regexFlags}g`
      : regexFlags.replace(/g/g, "");
    const regex = new RegExp(params.extractRegex, flags);

    if (mode === "lines_matching") {
      const lines = input.split(/\r?\n/).filter((line) => {
        regex.lastIndex = 0;
        return regex.test(line);
      });
      content = lines.slice(0, MAX_MATCHES).join("\n");
      extraction = {
        type: "regex",
        mode,
        matches: lines.length,
        returnedMatches: Math.min(lines.length, MAX_MATCHES),
      };
    } else if (mode === "first_match") {
      const match = regex.exec(input);
      content = match ? selectRegexGroup(match, params.extractGroup) : "";
      extraction = { type: "regex", mode, matches: match ? 1 : 0 };
    } else {
      const matches: string[] = [];
      let match: RegExpExecArray | null;
      while (
        (match = regex.exec(input)) !== null && matches.length < MAX_MATCHES
      ) {
        matches.push(selectRegexGroup(match, params.extractGroup));
        if (match[0] === "") regex.lastIndex += 1;
      }
      content = matches.join("\n");
      extraction = {
        type: "regex",
        mode: "all_matches",
        returnedMatches: matches.length,
      };
    }
  }

  const truncated = truncateText(content, maxChars);
  return {
    content: truncated.content,
    originalLength: text.length,
    returnedLength: truncated.content.length,
    truncated: truncated.truncated,
    ...(extraction ? { extraction } : {}),
  };
}

export default {
  key: "fetch_text",
  name: "Fetch Text",
  description:
    "Fetch text content from a URL and optionally filter or extract relevant text.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch text from." },
      timeout: {
        type: "number",
        description: "Timeout in seconds.",
        default: 15,
        minimum: 1,
        maximum: 60,
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return after filtering.",
        default: DEFAULT_MAX_CHARS,
        minimum: 1,
        maximum: MAX_CHARS_LIMIT,
      },
      contains: {
        type: "string",
        description: "Return only lines containing this case-insensitive text.",
      },
      extractRegex: {
        type: "string",
        description:
          "Optional regular expression for extracting text from the response.",
      },
      extractRegexFlags: {
        type: "string",
        description:
          "JavaScript regex flags. The tool adds g automatically for all_matches and lines_matching.",
      },
      extractGroup: {
        anyOf: [{ type: "number" }, { type: "string" }],
        description:
          "Optional numeric or named capture group to return from regex matches.",
      },
      mode: {
        type: "string",
        enum: ["full", "first_match", "all_matches", "lines_matching"],
        description: "How to shape the fetched text before returning.",
        default: "full",
      },
    },
    required: ["url"],
  },
  execute: async (params: FetchTextParams) => {
    const { url, timeout = 15 } = params;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      new URL(url); // Validate URL

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "AgentV2/1.0" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      const shaped = shapeFetchedText(text, params);

      return {
        url,
        content: shaped.content,
        length: shaped.returnedLength,
        originalLength: shaped.originalLength,
        truncated: shaped.truncated,
        ...(shaped.extraction ? { extraction: shaped.extraction } : {}),
        contentType: response.headers.get("content-type") || "unknown",
        status: response.status,
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`Request timeout after ${timeout} seconds`);
      }
      throw new Error(`Failed to fetch text: ${(error as Error).message}`);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  },
};
