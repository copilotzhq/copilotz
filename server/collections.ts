/**
 * Framework-independent collection helpers.
 * Collections are the preferred graph-backed application data abstraction.
 *
 * @module
 */

import type { Copilotz, CollectionsManager } from "@/index.ts";

export function createCollectionHandlers(copilotz: Copilotz) {
    const manager = copilotz.collections as CollectionsManager | undefined;

    return {
        /** List all registered collection names. */
        listCollections: (): string[] => {
            if (!manager || typeof manager.getCollectionNames !== "function") return [];
            return manager.getCollectionNames();
        },

        /** Check if a collection exists. */
        hasCollection: (name: string): boolean => {
            if (!manager || typeof manager.hasCollection !== "function") return false;
            return manager.hasCollection(name);
        },

        /**
         * Get a scoped CRUD interface for a collection.
         * @returns The collection CRUD or undefined if not found.
         */
        resolve: (collectionName: string, namespace?: string) => {
            if (!manager) return undefined;
            if (namespace) {
                const scoped = manager.withNamespace(namespace);
                return scoped[collectionName] ?? undefined;
            }
            return manager[collectionName] ?? undefined;
        },

        /** Execute a list/find query on a collection. */
        list: async (
            collectionName: string,
            options: {
                namespace?: string;
                filter?: Record<string, unknown>;
                limit?: number;
                offset?: number;
                sort?: Array<{ field: string; direction: "asc" | "desc" }>;
            } = {},
        ) => {
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

        /** Get a single item by ID from a collection. */
        getById: async (
            collectionName: string,
            id: string,
            options: { namespace?: string } = {},
        ) => {
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

        /** Create a new item in a collection. */
        create: async (
            collectionName: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ) => {
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

        /** Update an item in a collection by ID. */
        update: async (
            collectionName: string,
            id: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ) => {
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

        /** Delete an item from a collection by ID. */
        delete: async (
            collectionName: string,
            id: string,
            options: { namespace?: string } = {},
        ) => {
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

        /** Search a collection using text/semantic search. */
        search: async (
            collectionName: string,
            query: string,
            options: { namespace?: string; limit?: number } = {},
        ) => {
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
