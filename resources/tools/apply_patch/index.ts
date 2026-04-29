import {
  applyWorkspacePatch,
  summarizePatchOperations,
  type PatchOperation,
} from "@/resources/tools/_shared/fs-utils.ts";

interface ApplyPatchParams {
  path: string;
  operations: PatchOperation[];
}

export default {
  key: "apply_patch",
  name: "Apply Patch",
  description:
    "Apply targeted text edits to a file while capturing a restorable snapshot first. " +
    "All operations use text-anchored matching — not line numbers. " +
    "Always read the file first so your anchor text is current.",
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
          description:
            "A patch operation. Set 'type' to one of: 'replace', 'insert_before', 'insert_after'.\n" +
            "- replace: requires 'oldText' (unique substring to find) and 'newText' (replacement). " +
            "Set 'replaceAll: true' to replace every occurrence.\n" +
            "- insert_before: requires 'anchor' (unique substring) and 'content' (text to insert before it).\n" +
            "- insert_after: requires 'anchor' (unique substring) and 'content' (text to insert after it).\n" +
            "If the target text is not found, use search_code to locate the exact string first.",
          properties: {
            type: {
              type: "string",
              enum: ["replace", "insert_before", "insert_after"],
              description: "Operation type.",
            },
            oldText: {
              type: "string",
              description: "For 'replace': the unique substring to find. Must appear exactly once unless replaceAll is true.",
            },
            newText: {
              type: "string",
              description: "For 'replace': the replacement text.",
            },
            replaceAll: {
              type: "boolean",
              description: "For 'replace': if true, replace every occurrence of oldText.",
            },
            anchor: {
              type: "string",
              description: "For 'insert_before'/'insert_after': the unique substring that marks the insertion point.",
            },
            content: {
              type: "string",
              description: "For 'insert_before'/'insert_after': the text to insert.",
            },
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
      relativePath: result.relativePath,
      snapshotId: result.snapshotId,
      applied: result.applied,
      summary: summarizePatchOperations(operations),
    };
  },
};
