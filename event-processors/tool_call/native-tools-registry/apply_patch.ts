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
    "Apply targeted text edits to a file while capturing a restorable snapshot first. All operations use text-anchored matching (substring, not line-number based).",
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
          oneOf: [
            {
              type: "object",
              description:
                "Replace a unique substring with new text. The oldText must appear exactly once unless replaceAll is true.",
              properties: {
                type: { type: "string", const: "replace" },
                oldText: {
                  type: "string",
                  description: "Unique substring to find (any portion of the file, not limited to full lines).",
                },
                newText: { type: "string", description: "Replacement text." },
                replaceAll: {
                  type: "boolean",
                  description: "If true, replace every occurrence of oldText.",
                },
              },
              required: ["type", "oldText", "newText"],
            },
            {
              type: "object",
              description:
                "Insert content immediately before a unique anchor substring.",
              properties: {
                type: { type: "string", const: "insert_before" },
                anchor: {
                  type: "string",
                  description: "Unique substring to locate the insertion point.",
                },
                content: {
                  type: "string",
                  description: "Text to insert before the anchor.",
                },
              },
              required: ["type", "anchor", "content"],
            },
            {
              type: "object",
              description:
                "Insert content immediately after a unique anchor substring.",
              properties: {
                type: { type: "string", const: "insert_after" },
                anchor: {
                  type: "string",
                  description: "Unique substring to locate the insertion point.",
                },
                content: {
                  type: "string",
                  description: "Text to insert after the anchor.",
                },
              },
              required: ["type", "anchor", "content"],
            },
          ],
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
