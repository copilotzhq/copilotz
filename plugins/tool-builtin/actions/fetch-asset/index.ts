import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that fetches asset metadata.
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

export const fetchAssetAction: ActionDefinition<
  unknown,
  {
    assetId: string;
    assetRef: string;
    content: {
      readonly assetId: string;
      readonly kind: "text" | "image" | "audio" | "video" | "json" | "file";
      readonly role: "attachment";
      readonly mediaType: string;
    };
    mimeType: string;
    size: number;
  },
  ActionContext
> = defineAction({
  id: "copilotz.tools.builtin.fetch_asset",
  inputSchema: {
    type: "object",
    properties: {
      assetId: { type: "string" },
      id: { type: "string" },
      ref: { type: "string" },
    },
    anyOf: [{ required: ["assetId"] }, { required: ["id"] }, {
      required: ["ref"],
    }],
  },
  async execute(raw, context) {
    const id = assetIdFromInput(context.namespace, record(raw));
    const asset = await context.content.get(id);
    if (!asset) throw new Error(`Asset '${id}' was not found.`);
    const kind = assetKind(asset.mediaType);
    return {
      assetId: id,
      assetRef: formatAssetRef(context.namespace, id),
      content: {
        assetId: id,
        kind,
        role: "attachment",
        mediaType: asset.mediaType,
      } as const,
      mimeType: asset.mediaType,
      size: asset.byteLength,
    };
  },
});
