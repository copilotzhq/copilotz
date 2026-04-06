import { getWorkspaceFileDiff } from "./fs-utils.ts";

interface ShowFileDiffParams {
  path: string;
  snapshotId?: string;
}

export default {
  key: "show_file_diff",
  name: "Show File Diff",
  description:
    "Show the difference between the current file and a previously captured in-process snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file whose diff should be shown.",
      },
      snapshotId: {
        type: "string",
        description: "Optional snapshot ID. Defaults to the latest snapshot for the file.",
      },
    },
    required: ["path"],
  },
  execute: async ({ path, snapshotId }: ShowFileDiffParams) => {
    return await getWorkspaceFileDiff(path, snapshotId);
  },
};
