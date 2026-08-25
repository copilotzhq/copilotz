/**
 * Defines the data-only Apply Patch Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { applyPatchAction } from "../../actions/apply-patch/index.ts";

export const applyPatchTool = defineTool("apply_patch", applyPatchAction, {
  name: "Apply Patch",
  description:
    "Apply targeted text edits to a file while capturing a restorable snapshot first. All operations use text-anchored matching — not line numbers. Always read the file first so your anchor text is current.",
});
