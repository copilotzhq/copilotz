interface ListDirectoryParams {
  path?: string;
  showHidden?: boolean;
  recursive?: boolean;
  maxDepth?: number;
  excludePatterns?: string[];
  includeAll?: boolean;
  details?: boolean;
}

import { listWorkspaceDirectory } from "@/resources/tools/_shared/fs-utils.ts";

export default {
  key: "list_directory",
  name: "List Directory",
  description:
    "List files and folders in the current workspace, optionally traversing recursively. " +
    "Common noise directories (node_modules, .git, dist, build, etc.) are excluded by default.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the directory to list.",
        default: ".",
      },
      showHidden: {
        type: "boolean",
        description: "Include hidden files (starting with .).",
        default: false,
      },
      recursive: {
        type: "boolean",
        description: "Include entries from subdirectories.",
        default: false,
      },
      maxDepth: {
        type: "number",
        description: "Maximum recursion depth when recursive is enabled.",
        default: 2,
      },
      excludePatterns: {
        type: "array",
        items: { type: "string" },
        description: "Additional directory names to exclude (exact match).",
      },
      includeAll: {
        type: "boolean",
        description: "Disable default exclusions and include all directories.",
        default: false,
      },
      details: {
        type: "boolean",
        description: "Include file size for each entry. Off by default to keep output lean.",
        default: false,
      },
    },
  },
  execute: async ({
    path = ".",
    showHidden = false,
    recursive = false,
    maxDepth = 2,
    excludePatterns = [],
    includeAll = false,
    details = false,
  }: ListDirectoryParams) => {
    try {
      const listing = await listWorkspaceDirectory(path, {
        recursive,
        showHidden,
        maxDepth,
        excludePatterns,
        includeAll,
        details,
      });

      return {
        path: listing.relativePath,
        entries: listing.entries.map((e) => ({
          name: e.name,
          relativePath: e.relativePath,
          type: e.type,
          ...(details && e.size !== undefined && { size: e.size }),
        })),
        count: listing.entries.length,
      };
    } catch (error) {
      throw new Error(`Failed to list directory: ${(error as Error).message}`);
    }
  },
};
