import { restoreWorkspaceFileVersion } from "./fs-utils.ts";

interface RestoreFileVersionParams {
  path: string;
  snapshotId?: string;
}

export default {
  key: "restore_file_version",
  name: "Restore File Version",
  description:
    "Restore a file from a previously captured in-process snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to restore.",
      },
      snapshotId: {
        type: "string",
        description: "Optional snapshot ID. Defaults to the latest snapshot for the file.",
      },
    },
    required: ["path"],
  },
  execute: async ({ path, snapshotId }: RestoreFileVersionParams) => {
    return await restoreWorkspaceFileVersion(path, snapshotId);
  },
};
