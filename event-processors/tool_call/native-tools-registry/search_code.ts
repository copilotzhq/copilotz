import { searchWorkspaceCode } from "./fs-utils.ts";

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
}

export default {
  key: "search_code",
  name: "Search Code",
  description:
    "Search file contents in the current workspace and return line-level matches.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text or regex pattern to search for.",
      },
      directory: {
        type: "string",
        description: "Directory to search from. Defaults to the current workspace root.",
        default: ".",
      },
      filePattern: {
        type: "string",
        description: "Optional filename glob, for example *.ts or *.md.",
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
        default: 25,
      },
      maxMatchesPerFile: {
        type: "number",
        description: "Maximum number of matches returned per file.",
        default: 20,
      },
      maxDepth: {
        type: "number",
        description: "Maximum directory recursion depth.",
        default: 10,
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
    maxResults = 25,
    maxMatchesPerFile = 20,
    maxDepth = 10,
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
    });
  },
};
