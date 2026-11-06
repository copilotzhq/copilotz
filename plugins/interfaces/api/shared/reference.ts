/**
 * The API's reference, made from what the plugins declare
 * (`runtime.describe()`): for a key, what its scope lets it use, each Action
 * with its description and its input's JSON Schema, its queries and Views by
 * name, the collections it reads and writes directly, and where to call each;
 * for a person choosing what a key does, every Action the app has (the
 * catalog).
 */
import type { Description, Scope } from "../../../../runtime/mod.ts";

export type ActionEntry = {
  name: string;
  description?: string;
  input?: unknown;
  method: "POST";
  path: string;
};

export type Reference = {
  key?: { name: string; in: string; hint: string; role: string };
  actions: ActionEntry[];
  queries: { name: string; method: "POST"; path: string }[];
  views: { name: string; method: "GET"; path: string }[];
  /** Collections it reads or writes directly (over the app's socket), as the rules let it. */
  collections: { name: string; read: boolean; write: boolean }[];
  events: { method: "GET"; path: string };
};

const enc = encodeURIComponent;

/** What a key's scope lets it use, as the app declares it; Actions it doesn't have, left out. */
export function referenceOf(described: Description, scope: Scope): Reference {
  const read = new Set(scope.read ?? []);
  const write = new Set(scope.write ?? []);
  return {
    actions: (scope.call ?? []).flatMap((name) => {
      const action = described.actions[name];
      return action ? [actionEntry(name, action)] : [];
    }),
    queries: (scope.query ?? []).map((name) => ({
      name,
      method: "POST",
      path: `/api/queries/${enc(name)}`,
    })),
    views: (scope.view ?? []).map((name) => ({
      name,
      method: "GET",
      path: `/api/views/${enc(name)}`,
    })),
    collections: [...new Set([...read, ...write])].map((name) => ({
      name,
      read: read.has(name),
      write: write.has(name),
    })),
    events: { method: "GET", path: "/api/events" },
  };
}

/** Every Action the app has, by name, for choosing what a key does. */
export const catalogOf = (described: Description): ActionEntry[] =>
  Object.entries(described.actions)
    .map(([name, action]) => actionEntry(name, action))
    .sort((a, b) => a.name.localeCompare(b.name));

const actionEntry = (
  name: string,
  action: { description?: string; input?: unknown },
): ActionEntry => ({
  name,
  ...(action.description ? { description: action.description } : {}),
  ...(action.input ? { input: action.input } : {}),
  method: "POST",
  path: `/api/actions/${enc(name)}`,
});

/** Whether an Action takes a space (`in`) in its input: a key's, when the body names none. */
export const takesSpace = (described: Description, action: string): boolean => {
  const input = described.actions[action]?.input as
    | { properties?: Record<string, unknown> }
    | undefined;
  return !!input?.properties && "in" in input.properties;
};
