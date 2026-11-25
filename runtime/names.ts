import type { AppNames } from "./mod.ts";

/** A registry name from the app's generated declaration, or any string in a hand-written app. */
export type AppName<K extends "actions" | "collections" | "queries" | "views"> = AppNames extends
  Record<K, infer N extends string> ? N : string;

/** Known View names complete in an editor. A host can supply another View at runtime. */
export type ViewName = AppName<"views"> | (string & {});

/** The local names accepted by a collection's query method, without its collection prefix. */
export type LocalQuery<C extends string = AppName<"collections">> = string extends
  AppName<"queries"> ? string : QuerySuffix<AppName<"queries">, C>;

type QuerySuffix<Q, C extends string> = Q extends `${C}.${infer Name}` ? Name : never;
