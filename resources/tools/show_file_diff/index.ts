import { getWorkspaceFileDiff } from "@/resources/tools/_shared/fs-utils.ts";

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
    const result = await getWorkspaceFileDiff(path, snapshotId);
    return {
      relativePath: result.relativePath,
      snapshotId: result.snapshotId,
      changed: result.changed,
      truncated: result.truncated,
      beforeLabel: result.beforeLabel,
      afterLabel: result.afterLabel,
      hunks: result.hunks,
    };
  },
};
