/**
 * Defines the bounded Restore File Version Action.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { restoreWorkspaceFileVersion } from "../internal/fs-utils.ts";

interface RestoreFileVersionParams {
  path: string;
  snapshotId?: string;
}

export const restoreFileVersionAction = defineAction({
  id: "copilotz.tools.deno.restore_file_version",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to restore.",
      },
      snapshotId: {
        type: "string",
        description:
          "Optional snapshot ID. Defaults to the latest snapshot for the file.",
      },
    },
    required: ["path"],
  },
  execute: async ({ path, snapshotId }: RestoreFileVersionParams) => {
    const result = await restoreWorkspaceFileVersion(path, snapshotId);
    return {
      relativePath: result.relativePath,
      restoredFromSnapshotId: result.restoredFromSnapshotId,
    };
  },
});
