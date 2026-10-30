/**
 * The page's connection, once `web()` has made it: the client, and whom it
 * shows Views to. What `LazyView` observes with.
 */
import type { Client } from "../../runtime/client.ts";
import type { Viewer } from "../../runtime/mod.ts";

export const session: { client?: Client; viewer?: Viewer } = {};
