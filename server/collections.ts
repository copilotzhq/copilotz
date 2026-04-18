/**
 * Framework-independent collection helpers.
 * Collections are the preferred graph-backed application data abstraction.
 *
 * @module
 */

import type { Copilotz, CollectionsManager } from "@/index.ts";
import type { CollectionDefinition, CollectionPageInfo } from "@/database/collections/types.ts";

export interface CollectionListResult {
    data: unknown[];
    pageInfo?: CollectionPageInfo;
}

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
            before?: string;
            after?: string;
            sort?: Array<[string, "asc" | "desc"]>;
            populate?: string[];
        },
    ) => Promise<CollectionListResult>;
    getById: (
        collectionName: string,
        id: string,
        options?: { namespace?: string; populate?: string[] },
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
        options?: {
            namespace?: string;
            limit?: number;
            threshold?: number;
            filter?: Record<string, unknown>;
            populate?: string[];
        },
    ) => Promise<unknown[]>;
}

export function createCollectionHandlers(copilotz: Copilotz): CollectionHandlers {
    const manager = copilotz.collections as CollectionsManager | undefined;
    const definitions = new Map<string, CollectionDefinition>(
        (copilotz.config.collections ?? []).map((definition) => [definition.name, definition]),
    );

    const getDefinition = (collectionName: string): CollectionDefinition => {
        const definition = definitions.get(collectionName);
        if (!definition) {
            throw new Error(`Collection '${collectionName}' not found`);
        }
        return definition;
    };

    const getKeyField = (collectionName: string): string =>
        getDefinition(collectionName).keys?.[0]?.property ?? "id";

    const getCollectionCrud = (
        collectionName: string,
        namespace?: string,
    ): Record<string, unknown> => {
        if (!manager) throw new Error("Collections not configured");
        const coll = namespace
            ? manager.withNamespace(namespace)[collectionName]
            : manager[collectionName];
        if (!coll || typeof coll !== "object") {
            throw new Error(`Collection '${collectionName}' not found`);
        }
        return coll as Record<string, unknown>;
    };

    const getRouteFilter = (
        collectionName: string,
        value: string,
    ): Record<string, unknown> => {
        const keyField = getKeyField(collectionName);
        return { [keyField]: value };
    };

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

        list: (
            collectionName: string,
            options: {
                namespace?: string;
                filter?: Record<string, unknown>;
                limit?: number;
                offset?: number;
                before?: string;
                after?: string;
                sort?: Array<[string, "asc" | "desc"]>;
                populate?: string[];
            } = {},
        ): Promise<CollectionListResult> => (async () => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            const pageKey = getKeyField(collectionName);
            if ((options.before || options.after) && "findPage" in coll) {
                const crud = coll as {
                    findPage: (filter?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<CollectionListResult>;
                };
                return crud.findPage(options.filter, {
                    limit: options.limit,
                    sort: options.sort,
                    before: options.before,
                    after: options.after,
                    cursorField: pageKey,
                    populate: options.populate,
                });
            }
            if (!("find" in coll)) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as {
                find: (filter?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown[]>;
            };
            return {
                data: await crud.find(options.filter, {
                    limit: options.limit,
                    offset: options.offset,
                    sort: options.sort,
                    populate: options.populate,
                }),
            };
        })(),

        getById: (
            collectionName: string,
            id: string,
            options: { namespace?: string; populate?: string[] } = {},
        ): Promise<unknown> => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            const keyField = getKeyField(collectionName);
            if (keyField === "id" && "findById" in coll) {
                const crud = coll as { findById: (itemId: string, opts?: Record<string, unknown>) => Promise<unknown> };
                return crud.findById(id, { populate: options.populate });
            }
            if (!("findOne" in coll)) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as {
                findOne: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
            };
            return crud.findOne(getRouteFilter(collectionName, id), {
                populate: options.populate,
            });
        },

        create: (
            collectionName: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            if (!("create" in coll)) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { create: (row: Record<string, unknown>) => Promise<unknown> };
            return crud.create(data);
        },

        update: (
            collectionName: string,
            id: string,
            data: Record<string, unknown>,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            if (!("update" in coll)) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { update: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown> };
            return crud.update(getRouteFilter(collectionName, id), data);
        },

        delete: (
            collectionName: string,
            id: string,
            options: { namespace?: string } = {},
        ): Promise<unknown> => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            if (!("delete" in coll)) {
                throw new Error(`Collection '${collectionName}' not found`);
            }
            const crud = coll as { delete: (filter: Record<string, unknown>) => Promise<unknown> };
            return crud.delete(getRouteFilter(collectionName, id));
        },

        search: (
            collectionName: string,
            query: string,
            options: {
                namespace?: string;
                limit?: number;
                threshold?: number;
                filter?: Record<string, unknown>;
                populate?: string[];
            } = {},
        ): Promise<unknown[]> => {
            const coll = getCollectionCrud(collectionName, options.namespace);
            if (!("search" in coll)) {
                throw new Error(`Collection '${collectionName}' does not support search`);
            }
            const crud = coll as { search: (query: string, opts?: Record<string, unknown>) => Promise<unknown[]> };
            return crud.search(query, {
                limit: options.limit,
                threshold: options.threshold,
                where: options.filter,
                populate: options.populate,
            });
        },
    };
}
