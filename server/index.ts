/**
 * Framework-independent server helpers for Copilotz.
 *
 * These helpers wrap Copilotz operations into domain-specific handler factories
 * that can be wired to any web framework (Oxian, Hono, Express, etc.).
 *
 * @module
 *
 * @example
 * ```ts
 * import { createCopilotz } from "copilotz";
 * import { createThreadHandlers, createCollectionHandlers } from "copilotz/server";
 *
 * const copilotz = await createCopilotz({ ... });
 * const threads = createThreadHandlers(copilotz);
 * const collections = createCollectionHandlers(copilotz);
 *
 * // Wire to your framework's routes
 * app.get("/v1/threads/:id", async (req) => {
 *   return threads.getById(req.params.id);
 * });
 * ```
 */

export { createThreadHandlers } from "./threads.ts";
export type { ThreadHandlers } from "./threads.ts";

export { createMessageHandlers } from "./messages.ts";
export type { MessageHandlers } from "./messages.ts";

export { createEventHandlers } from "./events.ts";
export type { EventHandlers } from "./events.ts";

export { createAssetHandlers } from "./assets.ts";
export type { AssetHandlers } from "./assets.ts";

export { createCollectionHandlers } from "./collections.ts";
export type { CollectionHandlers } from "./collections.ts";

export { createGraphHandlers } from "./graph.ts";
export type { GraphHandlers, GraphSearchOptions } from "./graph.ts";

export { createRestHandlers, parseQueryParams, parseSort } from "./rest.ts";
export type { RestHandlers, RestListOptions } from "./rest.ts";
