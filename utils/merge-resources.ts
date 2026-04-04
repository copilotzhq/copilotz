/**
 * Resource merge utility for combining file-loaded and explicit resources.
 *
 * When both file-loaded and explicit resources are provided, explicit resources
 * are appended after file-loaded ones. If IDs collide, explicit definitions win.
 *
 * @module
 */

function getResourceId(item: Record<string, unknown>): string | undefined {
    const id = item.id ?? item.key ?? item.name;
    return typeof id === "string" ? id : undefined;
}

/**
 * Merges two resource arrays with "append, explicit wins on ID collision" semantics.
 *
 * @param fileLoaded - Resources loaded from the filesystem
 * @param explicit - Explicitly provided resources (override on collision)
 * @returns Merged array with explicit items replacing file-loaded items when IDs match
 */
export function mergeResourceArrays<T>(
    fileLoaded: T[],
    explicit: T[] | undefined,
): T[] {
    if (!explicit || explicit.length === 0) return fileLoaded;
    if (fileLoaded.length === 0) return explicit;

    const explicitIds = new Set<string>();
    for (const item of explicit) {
        const id = getResourceId(item as Record<string, unknown>);
        if (id) explicitIds.add(id);
    }

    // Keep file-loaded items whose IDs don't collide with explicit ones
    const kept = fileLoaded.filter((item) => {
        const id = getResourceId(item as Record<string, unknown>);
        return !id || !explicitIds.has(id);
    });

    return [...kept, ...explicit];
}
