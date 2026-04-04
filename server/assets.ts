/**
 * Framework-independent asset delivery helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import { parseAssetRef } from "@/utils/assets.ts";

export function createAssetHandlers(copilotz: Copilotz) {
    const { assets } = copilotz;

    return {
        /** Read an asset as base64. */
        getBase64: async (refOrId: string) => {
            const ref = refOrId.startsWith("asset://") ? refOrId : `asset://${refOrId}`;
            const parsed = parseAssetRef(ref);
            const options = parsed?.namespace ? { namespace: parsed.namespace } : undefined;
            return assets.getBase64(ref, options);
        },

        /** Read an asset as a data URL. */
        getDataUrl: async (refOrId: string) => {
            const ref = refOrId.startsWith("asset://") ? refOrId : `asset://${refOrId}`;
            const parsed = parseAssetRef(ref);
            const options = parsed?.namespace ? { namespace: parsed.namespace } : undefined;
            const dataUrl = await assets.getDataUrl(ref, options);
            const mimeMatch = typeof dataUrl === "string"
                ? dataUrl.match(/^data:([^;]+);base64,/)
                : null;
            return { dataUrl, mime: mimeMatch ? mimeMatch[1] : undefined };
        },

        /** Parse an asset reference string. */
        parseRef: (ref: string) => parseAssetRef(ref),
    };
}
