interface ListDirectoryParams {
  path: string;
  showHidden?: boolean;
  recursive?: boolean;
  maxDepth?: number;
}

import { listWorkspaceDirectory } from "@/resources/tools/_shared/fs-utils.ts";

export default {
  key: "list_directory",
  name: "List Directory",
  description:
    "List files and folders in the current workspace, optionally traversing recursively.",
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
        default: 3,
      },
    },
  },
  execute: async ({
    path = ".",
    showHidden = false,
    recursive = false,
    maxDepth = 3,
  }: ListDirectoryParams) => {
    try {
      const listing = await listWorkspaceDirectory(path, {
        recursive,
        showHidden,
        maxDepth,
      });

      return {
        path: listing.path,
        relativePath: listing.relativePath,
        entries: listing.entries,
        count: listing.entries.length,
      };
    } catch (error) {
      throw new Error(`Failed to list directory: ${(error as Error).message}`);
    }
  },
};
