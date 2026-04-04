/**
 * Resource merge utility for combining file-loaded and explicit resources.
 *
 * When both file-loaded and explicit resources are provided, explicit resources
 * are appended after file-loaded ones. If IDs collide, explicit definitions win.
 *
 * @module
 */

type ResourceItem = { id?: string; key?: string; name?: string };

function getResourceId(item: ResourceItem): string | undefined {
    return item.id ?? item.key ?? item.name ?? undefined;
}

/**
 * Merges two resource arrays with "append, explicit wins on ID collision" semantics.
 *
 * @param fileLoaded - Resources loaded from the filesystem
 * @param explicit - Explicitly provided resources (override on collision)
 * @returns Merged array with explicit items replacing file-loaded items when IDs match
 */
export function mergeResourceArrays<T extends ResourceItem>(
    fileLoaded: T[],
    explicit: T[] | undefined,
): T[] {
    if (!explicit || explicit.length === 0) return fileLoaded;
    if (fileLoaded.length === 0) return explicit;

    const explicitIds = new Set<string>();
    for (const item of explicit) {
        const id = getResourceId(item);
        if (id) explicitIds.add(id);
    }

    // Keep file-loaded items whose IDs don't collide with explicit ones
    const kept = fileLoaded.filter((item) => {
        const id = getResourceId(item);
        return !id || !explicitIds.has(id);
    });

    return [...kept, ...explicit];
}
