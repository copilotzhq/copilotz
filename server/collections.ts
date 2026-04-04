/**
 * Framework-independent collection helpers.
 * Collections are the preferred graph-backed application data abstraction.
 *
 * @module
 */

import type { Copilotz, CollectionsManager } from "@/index.ts";

/** Handlers returned by {@link createCollectionHandlers}. */
export interface CollectionHandlers {
    listCollections: () => string[];
    hasCollection: (name: string) => boolean;
    resolve: (collectionName: string, namespace?: string) => unknown;
    list: (
        collectionName: string,
        options?: {
            namespace?: string;
            filter?: Record<string, unknown>;
            limit?: number;
            offset?: number;
            sort?: Array<{ field: string; direction: "asc" | "desc" }>;
        },
    ) => Promise<unknown[]>;
    getById: (
        collectionName: string,
        id: string,
        options?: { namespace?: string },
    ) => Promise<unknown>;
    create: (
        collectionName: string,
        data: Record<string, unknown>,
        options?: { namespace?: string },
    ) => Promise<unknown>;
    update: (
        collectionName: string,
        id: string,
        data: Record<string, unknown>,
        options?: { namespace?: string },
    ) => Promise<unknown>;
    delete: (
        collectionName: string,
        id: string,
        options?: { namespace?: string },
    ) => Promise<unknown>;
    search: (
        collectionName: string,
        query: string,
        options?: { namespace?: string; limit?: number },
    ) => Promise<unknown[]>;
}

export function createCollectionHandlers(copilotz: Copilotz): CollectionHandlers {
    const manager = copilotz.collections as CollectionsManager | undefined;

    return {
        listCollections: (): string[] => {
            if (!manager || typeof manager.getCollectionNames !== "function") return [];
            return manager.getCollectionNames();
        },

        hasCollection: (name: string): boolean => {
            if (!manager || typeof manager.hasCollection !== "function") return false;
            return manager.hasCollection(name);
        },

        resolve: (collectionName: string, namespace?: string): unknown => {
            if (!manager) return undefined;
            if (namespace) {
                const scoped = manager.withNamespace(namespace);
                return scoped[collectionName] ?? undefined;
            }
            return manager[collectionName] ?? undefined;
        },

        list: async (
            collectionName: string,
            options: {
                namespace?: string;
                filter?: Record<string, unknown>;
                limit?: number;
                offset?: number;
                sort?: Array<{ field: string; direction: "asc" | "desc" }>;
            } = {},
        ): Promise<unknown[]> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("find" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { find: (filter?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown[]> };
            return crud.find(options.filter, {
                limit: options.limit,
                offset: options.offset,
                sort: options.sort,
            });
        },

        getById: async (
            collectionName: string,
            id: string,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("findOne" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { findOne: (filter: Record<string, unknown>) => Promise<unknown> };
            return crud.findOne({ id });
        },

        create: async (
            collectionName: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("create" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { create: (row: Record<string, unknown>) => Promise<unknown> };
            return crud.create(data);
        },

        update: async (
            collectionName: string,
            id: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("update" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { update: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown> };
            return crud.update({ id }, data);
        },

        delete: async (
            collectionName: string,
            id: string,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("delete" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { delete: (filter: Record<string, unknown>) => Promise<unknown> };
            return crud.delete({ id });
        },

        search: async (
            collectionName: string,
            query: string,
            options: { namespace?: string; limit?: number } = {},
        ): Promise<unknown[]> => {
            if (!manager) throw new Error("Collections not configured");
            const coll = options.namespace
                ? manager.withNamespace(options.namespace)[collectionName]
                : manager[collectionName];
            if (!coll || typeof coll !== "object" || !("search" in (coll as Record<string, unknown>))) {
                throw new Error(`Collection '${collectionName}' does not support search`);
            }
            const crud = coll as { search: (query: string, opts?: Record<string, unknown>) => Promise<unknown[]> };
            return crud.search(query, { limit: options.limit });
        },
    };
}
