/**
 * Framework-independent generic REST/CRUD helpers.
 * Wraps `copilotz.ops.crud` for direct table-level access.
 *
 * For application data, prefer collection helpers instead.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

/** Parsed query options for list endpoints. */
export interface RestListOptions {
    limit?: number;
    offset?: number;
    sort?: Array<{ field: string; direction: "asc" | "desc" }>;
    fields?: string[];
    filters?: Record<string, unknown>;
}

/** Coerce a string query parameter value to its natural type. */
function coerceValue(value: string | null): unknown {
    if (value === null) return null;
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (!Number.isNaN(Number(trimmed)) && trimmed !== "") return Number(trimmed);
    return trimmed;
}

/**
 * Parse a sort parameter string (e.g., "name:asc,-createdAt") into structured sort specs.
 */
export function parseSort(sortParam: string | null): Array<{ field: string; direction: "asc" | "desc" }> {
    if (!sortParam) return [];
    return sortParam
        .split(",")
        .map((raw) => {
            const part = raw.trim();
            if (!part) return null;
            let field = part;
            let direction: "asc" | "desc" = "asc";
            if (part.includes(":")) {
                const [f, dir] = part.split(":");
                field = (f || "").trim();
                direction = (dir || "").toLowerCase() === "desc" ? "desc" : "asc";
            } else if (part.startsWith("-")) {
                field = part.slice(1);
                direction = "desc";
            } else if (part.startsWith("+")) {
                field = part.slice(1);
                direction = "asc";
            }
            return field ? { field, direction } : null;
        })
        .filter(Boolean) as Array<{ field: string; direction: "asc" | "desc" }>;
}

/**
 * Parse URL search params into RestListOptions.
 * Extracts limit, offset, sort, fields, filters, and treats leftover params as equality filters.
 */
export function parseQueryParams(searchParams: URLSearchParams): RestListOptions {
    const limitRaw = searchParams.get("limit");
    const offsetRaw = searchParams.get("offset");
    const limit = limitRaw !== null && !Number.isNaN(Number(limitRaw)) ? Number(limitRaw) : undefined;
    const offset = offsetRaw !== null && !Number.isNaN(Number(offsetRaw)) ? Number(offsetRaw) : undefined;

    const sortSpecs = parseSort(searchParams.get("sort"));

    const fieldsParam = searchParams.get("fields");
    const fields = fieldsParam
        ? fieldsParam.split(",").map((f) => f.trim()).filter(Boolean)
        : undefined;

    const filters: Record<string, unknown> = {};
    const filtersParam = searchParams.get("filters");
    if (filtersParam) {
        try {
            const parsed = JSON.parse(filtersParam);
            if (parsed && typeof parsed === "object") {
                Object.assign(filters, parsed);
            }
        } catch {
            for (const pair of filtersParam.split(",")) {
                const [k, v] = pair.split(":");
                if (!k) continue;
                filters[k.trim()] = coerceValue(v ?? "");
            }
        }
    }

    const reserved = new Set(["limit", "offset", "skip", "sort", "fields", "filters", "populate"]);
    const seenKeys = new Set<string>();
    for (const key of searchParams.keys()) {
        if (reserved.has(key) || seenKeys.has(key)) continue;
        seenKeys.add(key);
        const allValues = searchParams.getAll(key);
        if (allValues.length > 1) {
            filters[key] = { $in: allValues.map((v) => coerceValue(v)) };
        } else {
            filters[key] = coerceValue(allValues[0] ?? null);
        }
    }

    return {
        limit,
        offset,
        sort: sortSpecs.length ? sortSpecs : undefined,
        fields,
        filters: Object.keys(filters).length ? filters : undefined,
    };
}

/** Handlers returned by {@link createRestHandlers}. */
export interface RestHandlers {
    list: (resource: string, options?: RestListOptions) => Promise<unknown[]>;
    getById: (resource: string, id: string) => Promise<unknown>;
    create: (resource: string, body: Record<string, unknown> | Array<Record<string, unknown>>) => Promise<unknown>;
    update: (resource: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
    delete: (resource: string, id: string) => Promise<unknown>;
    parseQueryParams: (searchParams: URLSearchParams) => RestListOptions;
}

export function createRestHandlers(copilotz: Copilotz): RestHandlers {
    const { ops } = copilotz;

    const resolveCrud = (resource: string): {
        find: (filter?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown[]>;
        findOne: (filter: Record<string, unknown>) => Promise<unknown>;
        create: (row: Record<string, unknown>) => Promise<unknown>;
        createMany: (rows: Array<Record<string, unknown>>) => Promise<unknown[]>;
        update: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
        delete: (filter: Record<string, unknown>) => Promise<unknown>;
    } => {
        const crud = ops.crud[resource as keyof typeof ops.crud];
        if (!crud) throw Object.assign(new Error(`Resource '${resource}' not found`), { status: 404 });
        return crud as unknown as ReturnType<typeof resolveCrud>;
    };

    return {
        list: async (resource: string, options: RestListOptions = {}): Promise<unknown[]> => {
            const crud = resolveCrud(resource);
            return crud.find(options.filters, {
                limit: options.limit,
                offset: options.offset,
                sort: options.sort,
                select: options.fields,
            });
        },

        getById: async (resource: string, id: string): Promise<unknown> => {
            const crud = resolveCrud(resource);
            return crud.findOne({ id });
        },

        create: async (resource: string, body: Record<string, unknown> | Array<Record<string, unknown>>): Promise<unknown> => {
            const crud = resolveCrud(resource);
            if (Array.isArray(body)) {
                return crud.createMany(body);
            }
            return crud.create(body);
        },

        update: async (resource: string, id: string, data: Record<string, unknown>): Promise<unknown> => {
            const crud = resolveCrud(resource);
            return crud.update({ id }, data);
        },

        delete: async (resource: string, id: string): Promise<unknown> => {
            const crud = resolveCrud(resource);
            return crud.delete({ id });
        },

        parseQueryParams,
    };
}
