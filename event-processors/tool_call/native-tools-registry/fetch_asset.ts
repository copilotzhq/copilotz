import type { ToolExecutionContext } from "../index.ts";
import { bytesToBase64, buildAssetRefForStore, resolveAssetIdForStore } from "@/utils/assets.ts";

type Params = {
	ref?: string;   // asset://<id> or asset://<namespace>/<id>
	id?: string;    // <id> (without scheme)
	format?: "dataUrl" | "base64";
};

export default {
	key: "fetch_asset",
	name: "Fetch Asset",
	description: "Fetch asset content by asset ref or id. Returns dataUrl or base64+mime.",
	inputSchema: {
		type: "object",
		properties: {
			ref: { type: "string", description: "asset://<id> or asset://<namespace>/<id>" },
			id: { type: "string", description: "asset id (without scheme)" },
			format: { type: "string", enum: ["dataUrl", "base64"], description: "Return format (default: dataUrl)" },
		},
		oneOf: [
			{ required: ["ref"] },
			{ required: ["id"] },
		],
	},
	execute: async ({ ref, id, format = "dataUrl" }: Params, context?: ToolExecutionContext) => {
		if (!context?.assetStore) throw new Error("Asset store not configured");
		const assetId = typeof ref === "string"
			? resolveAssetIdForStore(ref, context.assetStore)
			: (id ?? "");
		if (!assetId) throw new Error("Missing asset id/ref");
		if (format === "dataUrl") {
			const url = await context.assetStore.urlFor(assetId, { inline: true });
			return { assetRef: buildAssetRefForStore(context.assetStore, assetId), dataUrl: url };
		}
		const { bytes, mime } = await context.assetStore.get(assetId);
		const base64 = bytesToBase64(bytes);
		return { assetRef: buildAssetRefForStore(context.assetStore, assetId), base64, mime };
	},
}; 

