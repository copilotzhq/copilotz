import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that validates an existing asset reference.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import {
  assetIdFromInput,
  assetKind,
  formatAssetRef,
} from "../../shared/assets.ts";
import { record } from "../../shared/input.ts";

export const saveAssetAction: ActionDefinition<
  unknown,
  {
    assetId: string;
    assetRef: string;
    content: {
      assetId: string;
      kind: "text" | "image" | "audio" | "video" | "json" | "file";
      role: string;
      mediaType: string;
    };
    mimeType: string;
    size: number;
    kind: "text" | "image" | "audio" | "video" | "json" | "file";
  },
  ActionContext
> = defineAction({
  id: "copilotz.tools.builtin.save_asset",
  inputSchema: {
    type: "object",
    properties: { assetId: { type: "string" }, ref: { type: "string" } },
    oneOf: [{ required: ["assetId"] }, { required: ["ref"] }],
  },
  async execute(raw, context) {
    const id = assetIdFromInput(context.namespace, record(raw));
    const asset = await context.content.get(id);
    if (!asset) throw new Error(`Asset '${id}' was not found.`);
    const kind = assetKind(asset.mediaType);
    return {
      assetId: asset.id,
      assetRef: formatAssetRef(context.namespace, asset.id),
      content: {
        assetId: asset.id,
        kind,
        role: "attachment",
        mediaType: asset.mediaType,
      },
      mimeType: asset.mediaType,
      size: asset.byteLength,
      kind,
    };
  },
});
