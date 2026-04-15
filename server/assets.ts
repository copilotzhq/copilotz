/**
 * Framework-independent asset delivery helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import { parseAssetRef } from "@/runtime/storage/assets.ts";
import type { ParsedAssetRef } from "@/runtime/storage/assets.ts";

/** Handlers returned by {@link createAssetHandlers}. */
export interface AssetHandlers {
    getBase64: (refOrId: string) => Promise<{ base64: string; mime: string }>;
    getDataUrl: (refOrId: string) => Promise<{ dataUrl: string; mime: string | undefined }>;
    parseRef: (ref: string) => ParsedAssetRef | null;
}

export function createAssetHandlers(copilotz: Copilotz): AssetHandlers {
    const { assets } = copilotz;

    return {
        getBase64: async (refOrId: string): Promise<{ base64: string; mime: string }> => {
            const ref = refOrId.startsWith("asset://") ? refOrId : `asset://${refOrId}`;
            const parsed = parseAssetRef(ref);
            const options = parsed?.namespace ? { namespace: parsed.namespace } : undefined;
            return assets.getBase64(ref, options);
        },

        getDataUrl: async (refOrId: string): Promise<{ dataUrl: string; mime: string | undefined }> => {
            const ref = refOrId.startsWith("asset://") ? refOrId : `asset://${refOrId}`;
            const parsed = parseAssetRef(ref);
            const options = parsed?.namespace ? { namespace: parsed.namespace } : undefined;
            const dataUrl = await assets.getDataUrl(ref, options);
            const mimeMatch = typeof dataUrl === "string"
                ? dataUrl.match(/^data:([^;]+);base64,/)
                : null;
            return { dataUrl, mime: mimeMatch ? mimeMatch[1] : undefined };
        },

        parseRef: (ref: string): ParsedAssetRef | null => parseAssetRef(ref),
    };
}
