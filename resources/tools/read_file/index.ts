interface ReadFileParams {
  path: string;
  encoding?: string;
  startLine?: number;
  endLine?: number;
  includeLineNumbers?: boolean;
}

import { readWorkspaceFile } from "@/resources/tools/_shared/fs-utils.ts";

export default {
  key: "read_file",
  name: "Read File",
  description:
    "Read a file from the current workspace, optionally limiting the response to a line range.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read." },
      encoding: {
        type: "string",
        description: "Text encoding (always utf8 for text files).",
        default: "utf8",
      },
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
      return await readWorkspaceFile(path, {
        startLine,
        endLine,
        includeLineNumbers,
      });
    } catch (error) {
      throw new Error(`Failed to read file: ${(error as Error).message}`);
    }
  },
};
