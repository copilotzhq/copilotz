import { globToRegex, listWorkspaceDirectory } from "@/resources/tools/_shared/fs-utils.ts";

interface SearchFilesParams {
  directory?: string;
  pattern: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxResults?: number;
}

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
        description:
          "File name pattern to search for (supports * and ? wildcards).",
      },
      recursive: {
        type: "boolean",
        description: "Search subdirectories recursively.",
        default: true,
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
      maxResults: {
        type: "number",
        description: "Maximum number of matching files to return.",
        default: 50,
      },
    },
    required: ["pattern"],
  },
  execute: async ({
    directory = ".",
    pattern,
    recursive = true,
    includeHidden = false,
    maxDepth = 5,
    maxResults = 50,
  }: SearchFilesParams) => {
    try {
      const regex = globToRegex(pattern);
      const listing = await listWorkspaceDirectory(directory, {
        recursive,
        showHidden: includeHidden,
        maxDepth,
      });

      const limit = Math.max(1, maxResults);
      const results = [];
      for (const entry of listing.entries) {
        if (entry.type === "file" && regex.test(entry.name)) {
          results.push(entry);
          if (results.length >= limit) break;
        }
      }

      return {
        directory: listing.path,
        pattern,
        recursive,
        results,
        count: results.length,
        truncated: results.length >= limit,
      };
    } catch (error) {
      throw new Error(`File search failed: ${(error as Error).message}`);
    }
  },
};
