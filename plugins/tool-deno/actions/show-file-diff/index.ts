import type { DiffHunk } from "../internal/fs-utils.ts";
import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/**
 * Defines the bounded Show File Diff Action.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { getWorkspaceFileDiff } from "../internal/fs-utils.ts";

interface ShowFileDiffParams {
  path: string;
  snapshotId?: string;
}

export const showFileDiffAction: ActionDefinition<
  ShowFileDiffParams,
  {
    relativePath: string;
    snapshotId: string;
    changed: boolean;
    truncated: boolean;
    beforeLabel: string;
    afterLabel: string;
    hunks: DiffHunk[];
  },
  ActionContext
> = defineAction({
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
