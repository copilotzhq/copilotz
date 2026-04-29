interface ReadFileParams {
  path: string;
  encoding?: string;
  startLine?: number;
  endLine?: number;
  includeLineNumbers?: boolean;
}

import {
  readWorkspaceFile,
  resolveWorkspacePath,
} from "@/resources/tools/_shared/fs-utils.ts";

const AUTO_TRUNCATE_LINES = 300;
const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB — refuse to read without a range
const MAX_OUTPUT_BYTES = 100_000;      // 100KB — truncate output and warn

export default {
  key: "read_file",
  name: "Read File",
  description:
    "Read a file from the current workspace, optionally limiting the response to a line range. " +
    "Files over 300 lines are auto-truncated when no range is given. " +
    "Files over 1MB require an explicit range. Output is capped at 100KB.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read." },
      startLine: {
        type: "number",
        description: "Optional 1-based starting line.",
      },
      endLine: {
        type: "number",
        description: "Optional 1-based ending line.",
      },
      includeLineNumbers: {
        type: "boolean",
        description: "Prefix returned lines with their line numbers.",
        default: false,
      },
    },
    required: ["path"],
  },
  execute: async ({
    path,
    encoding: _encoding = "utf8",
    startLine,
    endLine,
    includeLineNumbers = false,
  }: ReadFileParams) => {
    try {
      const noRangeSpecified = startLine === undefined && endLine === undefined;

      // Pre-check: refuse files over 1MB when no range is specified.
      // Protects against reading large lockfiles, logs, or generated bundles into memory.
      if (noRangeSpecified) {
        // deno-lint-ignore no-explicit-any
        const denoNs = (globalThis as any).Deno;
        if (denoNs?.stat) {
          try {
            const { resolvedPath } = resolveWorkspacePath(path);
            const stat = await denoNs.stat(resolvedPath);
            if (stat.size > MAX_FILE_SIZE_BYTES) {
              throw new Error(
                `File is ${Math.round(stat.size / 1024)}KB — too large to read without a range. ` +
                `Use startLine/endLine to read a specific section, or use search_code to find the relevant part.`,
              );
            }
          } catch (error) {
            const msg = (error as Error).message;
            if (msg.includes("too large")) throw error;
            // stat unavailable or file not found — readWorkspaceFile will handle it
          }
        }
      }

      const resolvedEndLine = noRangeSpecified ? AUTO_TRUNCATE_LINES : endLine;

      const result = await readWorkspaceFile(path, {
        startLine,
        endLine: resolvedEndLine,
        includeLineNumbers,
      });

      const autoTruncated = noRangeSpecified && result.totalLines > AUTO_TRUNCATE_LINES;

      // Output byte cap: truncate and warn if content exceeds 100KB.
      // Catches minified files or very large explicit ranges.
      let content = result.content;
      let sizeWarning: string | undefined;
      if (content.length > MAX_OUTPUT_BYTES) {
        content = content.slice(0, MAX_OUTPUT_BYTES);
        sizeWarning =
          `Output truncated at 100KB. Use a narrower startLine/endLine range to read a specific section.`;
      }

      return {
        relativePath: result.relativePath,
        content,
        totalLines: result.totalLines,
        startLine: result.startLine,
        endLine: result.endLine,
        truncated: result.truncated,
        ...(autoTruncated && {
          autoTruncated: true,
          hint: `File has ${result.totalLines} lines. Showing lines 1–${AUTO_TRUNCATE_LINES}. Use startLine/endLine to read a specific range.`,
        }),
        ...(sizeWarning && { sizeWarning }),
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${(error as Error).message}`);
    }
  },
};
