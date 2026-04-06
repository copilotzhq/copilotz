import {
  applyWorkspacePatch,
  summarizePatchOperations,
  type PatchOperation,
} from "./fs-utils.ts";

interface ApplyPatchParams {
  path: string;
  operations: PatchOperation[];
}

export default {
  key: "apply_patch",
  name: "Apply Patch",
  description:
    "Apply targeted text or line-based edits to a file while capturing a restorable snapshot first.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative or absolute path inside the current workspace.",
      },
      operations: {
        type: "array",
        description: "Ordered patch operations to apply.",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "replace",
                "insert_before",
                "insert_after",
                "replace_lines",
                "delete_lines",
              ],
            },
            oldText: { type: "string" },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
            anchor: { type: "string" },
            content: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["type"],
        },
      },
    },
    required: ["path", "operations"],
  },
  execute: async ({ path, operations }: ApplyPatchParams) => {
    const result = await applyWorkspacePatch(path, operations);
    return {
      ...result,
      summary: summarizePatchOperations(operations),
    };
  },
};
