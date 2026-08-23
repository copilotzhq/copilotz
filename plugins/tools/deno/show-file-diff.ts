import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "../contracts.ts";
import { getWorkspaceFileDiff } from "./fs-utils.ts";

interface ShowFileDiffParams {
  path: string;
  snapshotId?: string;
}

export const showFileDiffAction = defineAction({
  id: "copilotz.tools.deno.show_file_diff",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file whose diff should be shown.",
      },
      snapshotId: {
        type: "string",
        description:
          "Optional snapshot ID. Defaults to the latest snapshot for the file.",
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
});

export const showFileDiffTool = defineTool(
  "show_file_diff",
  showFileDiffAction,
  {
    name: "Show File Diff",
    description:
      "Show the difference between the current file and a previously captured in-process snapshot.",
  },
);
