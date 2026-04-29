import { searchWorkspaceCode } from "@/resources/tools/_shared/fs-utils.ts";

interface SearchCodeParams {
  query: string;
  directory?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  isRegex?: boolean;
  includeHidden?: boolean;
  maxResults?: number;
  maxMatchesPerFile?: number;
  maxDepth?: number;
  excludePatterns?: string[];
  includeAll?: boolean;
  includeColumn?: boolean;
  includeMatch?: boolean;
}

export default {
  key: "search_code",
  name: "Search Code",
  description:
    "Search file contents in the current workspace and return line-level matches. " +
    "Common noise directories (node_modules, .git, dist, etc.) are excluded by default. " +
    "Narrow searches with directory and filePattern for faster, cleaner results.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text or regex pattern to search for.",
      },
      directory: {
        type: "string",
        description: "Directory to search from. Defaults to the workspace root. Narrow this first.",
        default: ".",
      },
      filePattern: {
        type: "string",
        description: "Optional filename glob, e.g. *.ts or *.md. Always set this when you know the language.",
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search should be case-sensitive.",
        default: false,
      },
      isRegex: {
        type: "boolean",
        description: "Treat query as a regular expression instead of plain text.",
        default: false,
      },
      includeHidden: {
        type: "boolean",
        description: "Include hidden files and folders.",
        default: false,
      },
      maxResults: {
        type: "number",
        description: "Maximum number of files to return.",
        default: 15,
      },
      maxMatchesPerFile: {
        type: "number",
        description: "Maximum number of matches returned per file.",
        default: 10,
      },
      maxDepth: {
        type: "number",
        description: "Maximum directory recursion depth.",
        default: 5,
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
      includeColumn: {
        type: "boolean",
        description: "Include column offset in match results.",
        default: false,
      },
      includeMatch: {
        type: "boolean",
        description: "Include the matched substring in results.",
        default: false,
      },
    },
    required: ["query"],
  },
  execute: async ({
    query,
    directory = ".",
    filePattern,
    caseSensitive = false,
    isRegex = false,
    includeHidden = false,
    maxResults = 15,
    maxMatchesPerFile = 10,
    maxDepth = 5,
    excludePatterns = [],
    includeAll = false,
    includeColumn = false,
    includeMatch = false,
  }: SearchCodeParams) => {
    return await searchWorkspaceCode({
      query,
      directory,
      filePattern,
      caseSensitive,
      isRegex,
      includeHidden,
      maxResults,
      maxMatchesPerFile,
      maxDepth,
      excludePatterns,
      includeAll,
      includeColumn,
      includeMatch,
    });
  },
};
