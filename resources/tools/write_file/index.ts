interface WriteFileParams {
  path: string;
  content: string;
  encoding?: string;
  createDirs?: boolean;
  append?: boolean;
}

import {
  ensureSnapshot,
  listSnapshots,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/resources/tools/_shared/fs-utils.ts";

export default {
  key: "write_file",
  name: "Write File",
  description:
    "Write or append UTF-8 text inside the current workspace, capturing a restorable snapshot before edits. " +
    "Use apply_patch instead when modifying an existing file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write." },
      content: { type: "string", description: "Content to write to the file." },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist.",
        default: false,
      },
      append: {
        type: "boolean",
        description: "Append content to the end of the file instead of replacing it.",
        default: false,
      },
    },
    required: ["path", "content"],
  },
  execute: async ({
    path,
    content,
    encoding: _encoding = "utf8",
    createDirs = false,
    append = false,
  }: WriteFileParams) => {
    try {
      // Warn if overwriting an existing file that was not read in this session.
      // listSnapshots returns snapshots accumulated during this session (from reads/prior writes).
      // If none exist yet, the agent hasn't touched this file — check after write whether
      // the file actually existed on disk (snapshotId will be non-null if it did).
      const priorSnapshots = listSnapshots(path);
      const hadPriorSnapshot = priorSnapshots.length > 0;

      let nextContent = content;
      if (append) {
        await ensureSnapshot(path, "append");
        try {
          const existing = await readWorkspaceFile(path);
          nextContent = existing.content.length > 0
            ? `${existing.content}${content}`
            : content;
        } catch {
          nextContent = content;
        }
      }

      const written = await writeWorkspaceFile(path, nextContent, {
        createDirs,
        snapshotLabel: append ? "append" : "write_file",
      });

      // snapshotId is non-null when the file existed on disk before the write
      const fileExistedOnDisk = written.snapshotId !== null;
      const overwroteUnread = fileExistedOnDisk && !hadPriorSnapshot && !append;

      return {
        relativePath: written.relativePath,
        snapshotId: written.snapshotId,
        created: !fileExistedOnDisk,
        appended: append,
        ...(overwroteUnread && {
          warning:
            "This file was not read before writing. Its previous content has been replaced. Use restore_file_version to undo if needed.",
        }),
      };
    } catch (error) {
      throw new Error(`Failed to write file: ${(error as Error).message}`);
    }
  },
};
