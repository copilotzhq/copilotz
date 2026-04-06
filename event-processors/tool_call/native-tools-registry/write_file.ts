interface WriteFileParams {
  path: string;
  content: string;
  encoding?: string;
  createDirs?: boolean;
  append?: boolean;
}

import {
  ensureSnapshot,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./fs-utils.ts";

export default {
  key: "write_file",
  name: "Write File",
  description:
    "Write or append UTF-8 text inside the current workspace, capturing a restorable snapshot before edits.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write." },
      content: { type: "string", description: "Content to write to the file." },
      encoding: {
        type: "string",
        description: "Text encoding (always utf8 for text files).",
        default: "utf8",
      },
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

      return {
        ...written,
        encoding: "utf8",
        created: createDirs,
        appended: append,
      };
    } catch (error) {
      throw new Error(`Failed to write file: ${(error as Error).message}`);
    }
  },
};
