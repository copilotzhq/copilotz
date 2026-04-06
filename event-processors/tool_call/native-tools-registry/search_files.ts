interface SearchFilesParams {
  directory?: string;
  pattern: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
}

import { listWorkspaceDirectory } from "./fs-utils.ts";

export default {
  key: "search_files",
  name: "Search Files",
  description: "Search for files by name pattern in the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Directory to search in.",
        default: ".",
      },
      pattern: {
        type: "string",
        description: "File name pattern to search for (supports * wildcards).",
      },
      recursive: {
        type: "boolean",
        description: "Search subdirectories recursively.",
        default: false,
      },
      includeHidden: {
        type: "boolean",
        description: "Include hidden files (starting with .).",
        default: false,
      },
      maxDepth: {
        type: "number",
        description: "Maximum recursion depth when recursive is enabled.",
        default: 5,
      },
    },
    required: ["pattern"],
  },
  execute: async ({
    directory = ".",
    pattern,
    recursive = false,
    includeHidden = false,
    maxDepth = 5,
  }: SearchFilesParams) => {
    try {
      const source = pattern
        .split("*")
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\?", "."))
        .join(".*");
      const regex = new RegExp(`^${source}$`, "i");
      const listing = await listWorkspaceDirectory(directory, {
        recursive,
        showHidden: includeHidden,
        maxDepth,
      });
      const results = listing.entries.filter((entry) =>
        entry.type === "file" && regex.test(entry.name)
      );

      return {
        directory: listing.path,
        pattern,
        recursive,
        results,
        count: results.length,
      };
    } catch (error) {
      throw new Error(`File search failed: ${(error as Error).message}`);
    }
  },
};
