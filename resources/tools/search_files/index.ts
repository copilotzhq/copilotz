import { globToRegex, listWorkspaceDirectory } from "@/resources/tools/_shared/fs-utils.ts";

interface SearchFilesParams {
  directory?: string;
  pattern: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxResults?: number;
  excludePatterns?: string[];
  includeAll?: boolean;
}

export default {
  key: "search_files",
  name: "Search Files",
  description:
    "Search for files by name pattern in the current workspace. " +
    "Common noise directories (node_modules, .git, dist, etc.) are excluded by default.",
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
        description: "File name pattern to search for (supports * and ? wildcards).",
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
      excludePatterns: {
        type: "array",
        items: { type: "string" },
        description: "Additional directory names to exclude (exact match).",
      },
      includeAll: {
        type: "boolean",
        description: "Disable default directory exclusions and search everything.",
        default: false,
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
    excludePatterns = [],
    includeAll = false,
  }: SearchFilesParams) => {
    try {
      const regex = globToRegex(pattern);
      const listing = await listWorkspaceDirectory(directory, {
        recursive,
        showHidden: includeHidden,
        maxDepth,
        excludePatterns,
        includeAll,
      });

      const limit = Math.max(1, maxResults);
      const results = [];
      for (const entry of listing.entries) {
        if (entry.type === "file" && regex.test(entry.name)) {
          results.push({ name: entry.name, relativePath: entry.relativePath });
          if (results.length >= limit) break;
        }
      }

      const truncated = results.length >= limit;

      return {
        directory: listing.relativePath,
        pattern,
        results,
        count: results.length,
        truncated,
        ...(truncated && {
          suggestion: "Results were truncated. Narrow the search with a more specific directory or reduce maxDepth.",
        }),
      };
    } catch (error) {
      throw new Error(`File search failed: ${(error as Error).message}`);
    }
  },
};
