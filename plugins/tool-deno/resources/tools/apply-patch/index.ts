import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Apply Patch Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { applyPatchAction } from "../../../actions/apply-patch/index.ts";

export const applyPatchTool: ToolDefinition<typeof applyPatchAction> =
  defineTool({
    ...applyPatchAction,
    ...{
      name: "Apply Patch",
      description:
        "Apply targeted text edits to a file while capturing a restorable snapshot first. All operations use text-anchored matching — not line numbers. Always read the file first so your anchor text is current.",
    },
  });

export default applyPatchTool;
