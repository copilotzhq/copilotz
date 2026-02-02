import type { ToolExecutionContext } from "../index.ts";
import { base64ToBytes, buildAssetRefForStore, resolveAssetIdForStore } from "@/utils/assets.ts";

interface SaveAssetParams {
	mimeType?: string;
	dataBase64?: string;
	ref?: string; // asset://<id> or asset://<namespace>/<id>
}

export default {
	key: "save_asset",
	name: "Save Asset",
	description: "Stores media bytes in the asset store and returns an assetRef. Accepts base64+mimeType, or an existing asset ref.",
	inputSchema: {
		type: "object",
		properties: {
			mimeType: { type: "string", description: "MIME type of the data" },
			dataBase64: { type: "string", description: "Base64-encoded bytes" },
			ref: { type: "string", description: "Existing asset ref (asset://<id> or asset://<namespace>/<id>)" },
		},
		oneOf: [
			{ required: ["mimeType", "dataBase64"] },
			{ required: ["ref"] },
		],
	},
	execute: async ({ mimeType, dataBase64, ref }: SaveAssetParams, context?: ToolExecutionContext) => {
		if (!context?.assetStore) {
			throw new Error("Asset store is not configured");
		}

		if (typeof ref === "string" && ref.startsWith("asset://")) {
			// Return existing ref (noop)
		const assetId = resolveAssetIdForStore(ref, context.assetStore);
		const { bytes, mime } = await context.assetStore.get(assetId);
		const assetRef = buildAssetRefForStore(context.assetStore, assetId);
			return {
			assetRef,
				mimeType: mime,
				size: bytes.byteLength,
				kind: mime.startsWith("image/") ? "image" : (mime.startsWith("audio/") ? "audio" : (mime.startsWith("video/") ? "video" : "file")),
			};
		}

		if (!mimeType || !dataBase64) {
			throw new Error("Either {ref} or {mimeType, dataBase64} is required");
		}

		const bytes = base64ToBytes(dataBase64);
		const { assetId } = await context.assetStore.save(bytes, mimeType);
	const assetRef = buildAssetRefForStore(context.assetStore, assetId);
		return {
			assetRef,
			mimeType,
			size: bytes.byteLength,
			kind: mimeType.startsWith("image/") ? "image" : (mimeType.startsWith("audio/") ? "audio" : (mimeType.startsWith("video/") ? "video" : "file")),
		};
	},
}; 

