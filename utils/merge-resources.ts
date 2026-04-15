/**
 * Resource merge utility for combining file-loaded and explicit resources.
 *
 * When both file-loaded and explicit resources are provided, explicit resources
 * win on ID collision. Ordering depends on the `prioritize` option.
 *
 * @module
 */

function getResourceId(item: Record<string, unknown>): string | undefined {
    const id = item.id ?? item.key ?? item.name;
    return typeof id === "string" ? id : undefined;
}

interface MergeOptions {
    /**
     * Which array appears first in the result.
     * - `"fileLoaded"` (default): `[...keptFileLoaded, ...explicit]`
     * - `"explicit"`: `[...explicit, ...keptFileLoaded]`
     *
     * In both cases, explicit wins on ID collision.
     */
    prioritize?: "fileLoaded" | "explicit";
}

/**
 * Merges two resource arrays. Explicit always wins on ID collision.
 *
 * @param fileLoaded - Resources loaded from the filesystem (lower priority)
 * @param explicit - Explicitly provided resources (override on collision)
 * @param options - Merge options (ordering)
 * @returns Merged array with explicit items replacing file-loaded items when IDs match
 */
export function mergeResourceArrays<T>(
    fileLoaded: T[],
    explicit: T[] | undefined,
    options?: MergeOptions,
): T[] {
    if (!explicit || explicit.length === 0) return fileLoaded;
    if (fileLoaded.length === 0) return explicit;

    const explicitIds = new Set<string>();
    for (const item of explicit) {
        const id = getResourceId(item as Record<string, unknown>);
        if (id) explicitIds.add(id);
    }

    const kept = fileLoaded.filter((item) => {
        const id = getResourceId(item as Record<string, unknown>);
        return !id || !explicitIds.has(id);
    });

    return options?.prioritize === "explicit"
        ? [...explicit, ...kept]
        : [...kept, ...explicit];
}
